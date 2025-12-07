const OpenAI = require('openai');
require('dotenv').config({ override: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.opentyphoon.ai/v1',
});

async function mail_classify(content, retries = 3) {
  const messages = [
    { role: 'system', content: 'คุณเป็นผู้ช่วย AI ที่มีหน้าที่ จำแนกอีเมลของ HR ของบริษัท ครีเดน เอเชีย (Creden Asia Company Limited) ให้อยู่ใน 5 หมวดหมู่ ดังนี้:\n\nGovernment: อีเมลที่ถูกส่งมาจาก หน่วยงานรัฐของประเทศไทย เช่น BOI, DEPA, DBD, กระทรวง, กรม หรือสำนักงานรัฐอื่น ๆ\n\nRecruitment: อีเมลที่มีเนื้อหาเกี่ยวกับ การสมัครงานของบริษัท ครีเดน เอเชีย (Creden Asia Company Limited) เท่านั้น เช่น ส่ง Resume, เซ็นสัญญาจ้าง หรือแจ้งเตือนจากแอปหางานเกี่ยวกับบริษัท ครีเดน เอเชีย (Creden Asia Company Limited)\n\nWelfare: อีเมลเกี่ยวกับ สวัสดิการพนักงาน เช่น Training, Course, ประกันภัย, ประกันสังคม, ตรวจสุขภาพ, โรงพยาบาล, ลาป่วย, ลากิจ, ลาพักร้อน เป็นต้น\n\nAffiliates: อีเมลที่ ไม่ได้เกี่ยวข้องกับบริษัท ครีเดน เอเชีย (Creden Asia Company Limited) โดยตรง แต่เข้ามาในกล่อง HR เช่น การสมัครงานบริษัทอื่น หรือการติดต่อเรื่องอื่นที่ไม่เกี่ยวข้องกับบริษัท ครีเดน เอเชีย (Creden Asia Company Limited)\n\nOthers: อีเมลที่ ไม่อยู่ในหมวดหมู่ใด ๆ ข้างต้น\n\nคำสั่งการจำแนก:\n\nอ่าน หัวข้ออีเมล และ เนื้อหาอีเมลทั้งหมด\n\nพิจารณา ความตั้งใจของผู้ส่ง และ บริบท ของอีเมล\n\nเลือกหมวดหมู่ที่ตรงที่สุดจาก 5 หมวดหมู่\n\nให้ผลลัพธ์ในรูปแบบ JSON ดังนี้:\n\n{\n  "category": "<หมวดหมู่>",\n  "purpose": "<สรุปวัตถุประสงค์ของอีเมลสั้นๆ ไม่เกิน 20 ตัวอักษร>"\n}\n\n\nตัวอย่างการใช้งาน:\n\nInput:\nหัวข้อ: "แจ้งสิทธิประโยชน์การตรวจสุขภาพประจำปี"\nเนื้อหา: "เรียน HR, บริษัทจัดตรวจสุขภาพประจำปีสำหรับพนักงานทุกคน..."\n\nOutput:\n\n{\n  "category": "Welfare",\n  "purpose": "แจ้งสิทธิประโยชน์ตรวจสุขภาพพนักงานประจำปี"\n}\n\n\nหมายเหตุ:\n\nหากอีเมลเกี่ยวกับ หลายเรื่อง ให้เลือกหมวดหมู่ที่ สำคัญที่สุดหรือเกี่ยวข้องกับ HR ของบริษัท ครีเดน เอเชีย (Creden Asia Company Limited)\n\nให้ตอบเฉพาะ JSON ตามรูปแบบด้านบน ห้ามเพิ่มข้อความอื่น ๆ\n\nสรุป purpose ให้ กระชับ ไม่เกิน 20 ตัวอักษร' },
    { role: 'user', content: content }
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await openai.chat.completions.create({
        model: 'typhoon-v2.1-12b-instruct',
        messages: messages,
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 0.9,
        repetition_penalty: 1.1,
      });

      let answer = result.choices[0].message.content;
      
      // Remove markdown code block format (```json ... ```)
      // Handle various markdown formats
      answer = answer.trim();
      
      // Remove ```json or ``` at the start
      if (answer.startsWith('```json')) {
        answer = answer.replace(/^```json\s*/i, '');
      } else if (answer.startsWith('```')) {
        answer = answer.replace(/^```\s*/, '');
      }
      
      // Remove ``` at the end
      if (answer.endsWith('```')) {
        answer = answer.replace(/\s*```$/, '');
      }
      
      // Trim whitespace again
      answer = answer.trim();
      
      return JSON.parse(answer);
    } catch (error) {
      // Handle rate limit (429) or server errors (5xx)
      if ((error.status === 429 || (error.status >= 500 && error.status < 600)) && attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.warn(`Rate limit hit, retrying in ${delay}ms... (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

module.exports = { mail_classify };

