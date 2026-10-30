const { initPool, pool } = require('../config/database');

async function checkBabyAnn() {
  await initPool();
  
  try {
    console.log('\n=== Checking Baby Ann Diagbel Data ===\n');
    
    // Get patient record
    const [patients] = await pool.query(`
      SELECT 
        p.patient_id,
        p.registration_number,
        p.full_name,
        p.vaccine_d0,
        p.vaccine_d3,
        p.vaccine_d7,
        p.vaccine_d14,
        p.vaccine_d28,
        p.outcome,
        p.treatment_status,
        p.schedule_suspended,
        p.missed_dose,
        p.next_schedule
      FROM patients p
      WHERE p.full_name LIKE '%Baby Ann%' 
         OR p.full_name LIKE '%Diagbel%'
    `);
    
    if (!patients.length) {
      console.log('❌ Patient not found');
      process.exit(0);
    }
    
    const patient = patients[0];
    console.log('📋 Patient Record:');
    console.log(JSON.stringify(patient, null, 2));
    
    // Get treatment episodes
    const [episodes] = await pool.query(`
      SELECT 
        episode_id,
        episode_number,
        treatment_cycle,
        vaccine_d0,
        vaccine_d3,
        vaccine_d7,
        vaccine_d14,
        vaccine_d28,
        status,
        outcome,
        schedule_suspended
      FROM treatment_episodes
      WHERE patient_id = ?
      ORDER BY episode_number DESC
    `, [patient.patient_id]);
    
    console.log('\n📝 Treatment Episodes:');
    console.log(JSON.stringify(episodes, null, 2));
    
    // Get PEP schedule
    const [schedule] = await pool.query(`
      SELECT *
      FROM patient_pep_schedule
      WHERE patient_id = ?
      ORDER BY 
        CASE day_label
          WHEN 'Day 0' THEN 1
          WHEN 'Day 3' THEN 2
          WHEN 'Day 7' THEN 3
          WHEN 'Day 14' THEN 4
          WHEN 'Day 28' THEN 5
        END
    `, [patient.patient_id]);
    
    console.log('\n💉 PEP Schedule:');
    console.log(JSON.stringify(schedule, null, 2));
    
    // Analysis
    console.log('\n🔍 ANALYSIS:');
    const allGiven = schedule.every(s => s.date_given !== null);
    const hasD28 = patient.vaccine_d28 !== null;
    
    console.log(`All doses recorded in PEP schedule: ${allGiven ? 'YES ✅' : 'NO ❌'}`);
    console.log(`D28 in patients table: ${hasD28 ? 'YES ✅' : 'NO ❌'}`);
    console.log(`Current outcome: ${patient.outcome || 'NULL'}`);
    console.log(`Current status: ${patient.treatment_status || 'NULL'}`);
    console.log(`Next schedule: ${patient.next_schedule || 'NULL'}`);
    
    if (allGiven && hasD28 && patient.outcome !== 'C') {
      console.log('\n⚠️ ISSUE FOUND: Treatment is complete but outcome is not "C"');
      console.log('   This causes the system to show "Due Today" incorrectly');
    }
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkBabyAnn();
