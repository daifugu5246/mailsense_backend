const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../config/supabase');
const { mail_classify } = require('../services/typhoon');

// Get all emails for the current user
router.get('/', async (req, res) => {
  try {
    // ดึง access token จาก cookie
    const accessToken = req.cookies.access_token;
    
    if (!accessToken) {
      return res.status(401).json({ 
        success: false,
        error: 'Unauthorized - No access token found' 
      });
    }

    // ดึงข้อมูล user จาก cookie เพื่อใช้ email
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const userEmail = userResponse.data.email;

    // Query parameters สำหรับ pagination และ filtering
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const category = req.query.category; // Filter by category
    const search = req.query.search; // Search in subject or from_address
    const sortBy = req.query.sortBy || 'received_at'; // Sort field
    const sortOrder = req.query.sortOrder || 'desc'; // asc or desc

    // สร้าง query
    let query = supabase
      .from('mails')
      .select('*', { count: 'exact' })
      .eq('user_email', userEmail);

    // Filter by category
    if (category) {
      query = query.eq('category', category);
    }

    // Search in subject or from_address
    if (search) {
      query = query.or(`subject.ilike.%${search}%,from_address.ilike.%${search}%,from_name.ilike.%${search}%`);
    }

    // Sorting
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });

    // Pagination
    query = query.range(offset, offset + limit - 1);

    const { data: emails, error, count } = await query;

    if (error) {
      console.error('Error fetching emails:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch emails',
        message: error.message
      });
    }

    res.json({
      success: true,
      data: emails || [],
      pagination: {
        page: page,
        limit: limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching emails:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Invalid or expired access token'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch emails',
      message: error.message
    });
  }
});

// Fetch emails from Gmail API (Streaming)
router.post('/fetch', async (req, res) => {
  try {
    // ดึง access token จาก cookie
    const accessToken = req.cookies.access_token;
    
    if (!accessToken) {
      return res.status(401).json({ 
        success: false,
        error: 'Unauthorized - No access token found' 
      });
    }

    // ตั้งค่า headers สำหรับ streaming response
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // ดึงข้อมูล user จาก cookie เพื่อใช้ email
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const userEmail = userResponse.data.email;

    // เรียก Gmail API เพื่อดึง unread emails ใน 24 ชั่วโมงล่าสุด
    const messagesResponse = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        maxResults: 500, // เพิ่ม maxResults เพื่อดึง unread ทั้งหมด (Gmail API limit คือ 500)
        q: 'is:unread newer_than:1d' // ดึง unread emails ที่ได้รับใน 24 ชั่วโมงล่าสุด
      }
    });

    const messages = messagesResponse.data.messages || [];
    
    if (messages.length === 0) {
      res.write(JSON.stringify({
        type: 'complete',
        success: true,
        message: 'No new emails found',
        count: 0,
        total_processed: 0
      }) + '\n');
      return res.end();
    }

    // ดึง message IDs ที่มีอยู่แล้วใน database สำหรับ user นี้
    const messageIds = messages.map(m => m.id);
    const { data: existingMails } = await supabase
      .from('mails')
      .select('google_message_id')
      .eq('user_email', userEmail)
      .in('google_message_id', messageIds);

    const existingMessageIds = new Set(existingMails?.map(m => m.google_message_id) || []);

    // Filter ออก message IDs ที่มีอยู่แล้ว
    const newMessages = messages.filter(m => !existingMessageIds.has(m.id));
    const skippedCount = messages.length - newMessages.length;

    if (newMessages.length === 0) {
      res.write(JSON.stringify({
        type: 'complete',
        success: true,
        message: `All ${messages.length} emails have already been fetched`,
        count: 0,
        total_processed: 0,
        skipped: skippedCount
      }) + '\n');
      return res.end();
    }

    // ส่ง initial message
    res.write(JSON.stringify({
      type: 'start',
      total: newMessages.length,
      skipped: skippedCount,
      message: `Starting to fetch ${newMessages.length} new emails (${skippedCount} already fetched)`
    }) + '\n');

    // ดึงรายละเอียดของแต่ละ email และประมวลผลแบบ batch
    const BATCH_SIZE = 10; // ประมวลผลทีละ 10 emails
    const DELAY_BETWEEN_BATCHES = 500; // Delay 500ms ระหว่างแต่ละ batch
    const DELAY_BETWEEN_CLASSIFY = 100; // Delay 100ms ระหว่างการ classify แต่ละ email
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < newMessages.length; i++) {
      const message = newMessages[i];
      try {
        const messageDetail = await axios.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`
            },
            params: {
              format: 'full'
            }
          }
        );

        const msg = messageDetail.data;
        
        // Parse email headers
        const headers = msg.payload.headers;
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        
        const subject = getHeader('subject');
        const from = getHeader('from');
        const date = getHeader('date');
        
        // Parse from address and name
        let fromAddress = '';
        let fromName = '';
        if (from) {
          const fromMatch = from.match(/(.+?)\s*<(.+?)>/);
          if (fromMatch) {
            fromName = fromMatch[1].trim().replace(/"/g, '');
            fromAddress = fromMatch[2].trim();
          } else {
            fromAddress = from.trim();
          }
        }
        
        // Extract body text
        let bodyText = '';
        const extractBody = (part) => {
          if (part.body?.data) {
            const text = Buffer.from(part.body.data, 'base64').toString('utf-8');
            if (part.mimeType === 'text/plain') {
              bodyText += text;
            }
          }
          if (part.parts) {
            part.parts.forEach(extractBody);
          }
        };
        
        if (msg.payload.parts) {
          msg.payload.parts.forEach(extractBody);
        } else if (msg.payload.body?.data) {
          bodyText = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
        }
        
        // Parse date
        const receivedAt = date ? new Date(date) : new Date(msg.internalDate ? parseInt(msg.internalDate) : Date.now());
        
        // ตรวจสอบว่า email นี้มีอยู่แล้วหรือไม่
        const { data: existingMail } = await supabase
          .from('mails')
          .select('*')
          .eq('google_message_id', msg.id)
          .single();
        
        const isExisting = existingMail !== null;
        
        let category = existingMail?.category || null;
        let purpose = existingMail?.purpose || null;
        
        // Classify เฉพาะ email ใหม่หรือ email ที่ยังไม่มี category
        if (!category && !purpose) {
          try {
            // เพิ่ม delay เพื่อหลีกเลี่ยง rate limit
            // Delay 300ms ระหว่างแต่ละ classification
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CLASSIFY));
            }
            
            // Delay 1 วินาที หลังจากประมวลผลทุก 5 emails
            if (i > 0 && i % BATCH_SIZE === 0) {
              console.log(`Processed ${i} emails, waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...`);
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
            
            const classification = await mail_classify(`หัวข้อ: ${subject}\nเนื้อหา: ${bodyText.substring(0, 1000)}`);
            category = classification.category;
            purpose = classification.purpose;
            console.log(`[${i + 1}/${messages.length}] Classified: ${category}`);
          } catch (classifyError) {
            console.error(`Error classifying email ${msg.id}:`, classifyError.message);
            // Continue without classification
          }
        } else {
          console.log(`[${i + 1}/${messages.length}] Skipped classification (already exists): ${category}`);
        }
        
        let result;
        let error;
        
        if (isExisting) {
          // ถ้ามีอยู่แล้ว: อัปเดตเฉพาะ field ที่จำเป็น
          const updateData = {
            fetched_at: new Date().toISOString()
          };
          
          // อัปเดต category และ purpose เฉพาะถ้ายังไม่มี
          if (!existingMail.category && category) {
            updateData.category = category;
          }
          if (!existingMail.purpose && purpose) {
            updateData.purpose = purpose;
          }
          
          // อัปเดตข้อมูลพื้นฐานที่อาจเปลี่ยนได้ (subject, from_address, from_name)
          // แต่ไม่ update correctness, interaction, interaction_at (เพราะ user อาจแก้ไขแล้ว)
          updateData.subject = subject;
          updateData.from_address = fromAddress;
          updateData.from_name = fromName;
          
          const { data: updatedMail, error: updateError } = await supabase
            .from('mails')
            .update(updateData)
            .eq('google_message_id', msg.id)
            .select()
            .single();
          
          result = updatedMail;
          error = updateError;
        } else {
          // ถ้ายังไม่มี: Insert ใหม่
          const emailData = {
            id: msg.id,
            user_email: userEmail,
            google_message_id: msg.id,
            thread_id: msg.threadId,
            subject: subject,
            from_address: fromAddress,
            from_name: fromName,
            body_text: bodyText.substring(0, 50000), // Limit body text length
            received_at: receivedAt.toISOString(),
            category: category,
            purpose: purpose,
            correctness: 'none', // Default value
            interaction: false,
            fetched_at: new Date().toISOString()
          };
          
          const { data: insertedMail, error: insertError } = await supabase
            .from('mails')
            .insert(emailData)
            .select()
            .single();
          
          result = insertedMail;
          error = insertError;
        }
        
        if (error) {
          console.error(`Error ${isExisting ? 'updating' : 'inserting'} email:`, error);
          failCount++;
          // ส่ง error message
          res.write(JSON.stringify({
            type: 'error',
            email_id: msg.id,
            error: error.message
          }) + '\n');
        } else {
          successCount++;
          // ส่ง email data ทันทีเมื่อ classify และบันทึกเสร็จ
          res.write(JSON.stringify({
            type: 'email',
            data: result,
            progress: {
              current: i + 1,
              total: messages.length
            }
          }) + '\n');
        }
      } catch (error) {
        console.error(`Error fetching message ${message.id}:`, error.message);
        failCount++;
        res.write(JSON.stringify({
          type: 'error',
          email_id: message.id,
          error: error.message
        }) + '\n');
      }
    }

    // ส่ง final message
    res.write(JSON.stringify({
      type: 'complete',
      success: true,
      message: `Fetched and saved ${successCount} emails`,
      total_processed: newMessages.length,
      success_count: successCount,
      fail_count: failCount,
      skipped: skippedCount
    }) + '\n');
    
    res.end();

  } catch (error) {
    console.error('Error fetching emails:', error);
    
    if (error.response?.status === 401) {
      res.write(JSON.stringify({
        type: 'error',
        success: false,
        error: 'Unauthorized - Invalid or expired access token'
      }) + '\n');
      return res.end();
    }
    
    res.write(JSON.stringify({
      type: 'error',
      success: false,
      error: 'Failed to fetch emails',
      message: error.message
    }) + '\n');
    res.end();
  }
});

// Update correctness of an email
router.patch('/correctness', async (req, res) => {
  try {
    // ดึง access token จาก cookie
    const accessToken = req.cookies.access_token;
    
    if (!accessToken) {
      return res.status(401).json({ 
        success: false,
        error: 'Unauthorized - No access token found' 
      });
    }

    // ดึงข้อมูล user จาก cookie เพื่อใช้ email
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const userEmail = userResponse.data.email;

    // รับข้อมูลจาก request body
    const { message_id, correctness } = req.body;

    // Validate input
    if (!message_id) {
      return res.status(400).json({
        success: false,
        error: 'message_id is required'
      });
    }

    if (!correctness) {
      return res.status(400).json({
        success: false,
        error: 'correctness is required'
      });
    }

    // Validate correctness value (ต้องเป็น 'correct', 'none', หรือ 'wrong')
    const validCorrectness = ['correct', 'none', 'wrong'];
    if (!validCorrectness.includes(correctness)) {
      return res.status(400).json({
        success: false,
        error: `correctness must be one of: ${validCorrectness.join(', ')}`
      });
    }

    // Update correctness ใน database
    const { data: updatedMail, error: updateError } = await supabase
      .from('mails')
      .update({
        correctness: correctness
      })
      .eq('google_message_id', message_id)
      .eq('user_email', userEmail) // ตรวจสอบว่าเป็น email ของ user นี้
      .select()
      .single();

    if (updateError) {
      console.error('Error updating correctness:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to update correctness',
        message: updateError.message
      });
    }

    if (!updatedMail) {
      return res.status(404).json({
        success: false,
        error: 'Email not found or you do not have permission to update it'
      });
    }

    res.json({
      success: true,
      message: 'Correctness updated successfully',
      data: updatedMail
    });

  } catch (error) {
    console.error('Error updating correctness:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Invalid or expired access token'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update correctness',
      message: error.message
    });
  }
});

// Update interaction when user clicks on email link
router.patch('/interaction', async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - No access token found' 
      });
    }

    // ดึงข้อมูล user จาก cookie เพื่อใช้ email
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const userEmail = userResponse.data.email;

    // รับข้อมูลจาก request body
    const { message_id } = req.body;

    // Validate input
    if (!message_id) {
      return res.status(400).json({
        success: false,
        error: 'message_id is required'
      });
    }

    // Update interaction ใน database
    const { data: updatedMail, error: updateError } = await supabase
      .from('mails')
      .update({
        interaction: true,
        interaction_at: new Date().toISOString()
      })
      .eq('google_message_id', message_id)
      .eq('user_email', userEmail) // ตรวจสอบว่าเป็น email ของ user นี้
      .select()
      .single();

    if (updateError) {
      console.error('Database update error:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to update interaction',
        details: updateError.message
      });
    }

    if (!updatedMail) {
      return res.status(404).json({
        success: false,
        error: 'Email not found or does not belong to this user'
      });
    }

    res.json({
      success: true,
      message: 'Interaction recorded successfully',
      data: updatedMail
    });

  } catch (error) {
    console.error('Error updating interaction:', error);
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Invalid or expired access token'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update interaction',
      message: error.message
    });
  }
});

module.exports = router;

