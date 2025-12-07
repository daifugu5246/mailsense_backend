const { mail_classify } = require('./services/typhoon.js');
require('dotenv').config({ override: true });

async function testMailClassify() {
  try {
    console.log('Testing mail_classify function...\n');

    // Test case 1: สวัสดิการ
    const testCase1 = {
      subject: 'แจ้งสิทธิประโยชน์การตรวจสุขภาพประจำปี',
      content: 'เรียน HR, บริษัทจัดตรวจสุขภาพประจำปีสำหรับพนักงานทุกคน วันที่ 15 มกราคม 2567 ณ โรงพยาบาลกรุงเทพ'
    };

    console.log('Test Case 1: สวัสดิการ');
    console.log('Input:', testCase1);
    const result1 = await mail_classify(`หัวข้อ: ${testCase1.subject}\nเนื้อหา: ${testCase1.content}`);
    console.log('Output:', result1);
    console.log('---\n');

    // Test case 2: ใบสมัครงาน
    const testCase2 = {
      subject: 'ส่ง Resume สำหรับตำแหน่ง Software Developer',
      content: 'เรียน HR, ผมสนใจสมัครงานตำแหน่ง Software Developer ที่บริษัท OK ครับ'
    };

    console.log('Test Case 2: ใบสมัครงาน');
    console.log('Input:', testCase2);
    const result2 = await mail_classify(`หัวข้อ: ${testCase2.subject}\nเนื้อหา: ${testCase2.content}`);
    console.log('Output:', result2);
    console.log('---\n');

    // Test case 3: ภาครัฐ
    const testCase3 = {
      subject: 'แจ้งจาก BOI เรื่องสิทธิประโยชน์การลงทุน',
      content: 'เรียน บริษัท OK, ทาง BOI แจ้งเรื่องสิทธิประโยชน์การลงทุนสำหรับบริษัทที่ได้รับ BOI Certificate'
    };

    console.log('Test Case 3: ภาครัฐ');
    console.log('Input:', testCase3);
    const result3 = await mail_classify(`หัวข้อ: ${testCase3.subject}\nเนื้อหา: ${testCase3.content}`);
    console.log('Output:', result3);
    console.log('---\n');

    // Test case 4: บริษัทในเครือ
    const testCase4 = {
      subject: 'สอบถามตำแหน่งงานที่บริษัท XYZ',
      content: 'เรียน HR, ผมสนใจสมัครงานที่บริษัท XYZ ครับ'
    };

    console.log('Test Case 4: บริษัทในเครือ');
    console.log('Input:', testCase4);
    const result4 = await mail_classify(`หัวข้อ: ${testCase4.subject}\nเนื้อหา: ${testCase4.content}`);
    console.log('Output:', result4);
    console.log('---\n');

    console.log('All tests completed!');

  } catch (error) {
    console.error('Error testing mail_classify:', error);
    if (error.message?.includes('OPENAI_API_KEY')) {
      console.error('\nPlease make sure OPENAI_API_KEY is set in your .env file');
    }
  }
}

// Run the test
testMailClassify();

