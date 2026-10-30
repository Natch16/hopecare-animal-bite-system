const { initPool, pool } = require('../config/database');

async function fixBabyAnn() {
  await initPool();
  
  try {
    console.log('\n=== Fixing Baby Ann Diagbel Schedule ===\n');
    
    // Get patient record
    const [[patient]] = await pool.query(`
      SELECT patient_id, full_name, category, outcome, 
             vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28
      FROM patients 
      WHERE full_name LIKE '%Baby Ann%' OR full_name LIKE '%Diagbel%'
    `);
    
    if (!patient) {
      console.log('❌ Patient not found');
      process.exit(0);
    }
    
    console.log('📋 Patient:', patient.full_name);
    console.log('   Category:', patient.category);
    console.log('   Outcome:', patient.outcome);
    console.log('   D0:', patient.vaccine_d0);
    console.log('   D3:', patient.vaccine_d3);
    console.log('   D7:', patient.vaccine_d7);
    console.log('   D14:', patient.vaccine_d14);
    console.log('   D28:', patient.vaccine_d28);
    
    // Check if treatment is complete based on category
    const category = String(patient.category || '').trim();
    const isCategory1 = category === 'I' || category === '1' || category === 'Category I';
    const hasAllDoses = !!(patient.vaccine_d0 && patient.vaccine_d3 && patient.vaccine_d7);
    
    if (isCategory1 && hasAllDoses && patient.outcome === 'C') {
      console.log('\n✅ Patient has completed Category I treatment (D0, D3, D7)');
      console.log('   But system might be calculating D14 as "due"');
      
      // Update next_schedule to null
      const [result] = await pool.query(`
        UPDATE patients 
        SET next_schedule = NULL,
            treatment_status = 'Completed'
        WHERE patient_id = ?
      `, [patient.patient_id]);
      
      if (result.affectedRows > 0) {
        console.log('\n✅ Fixed: Set next_schedule = NULL and treatment_status = Completed');
      }
      
      // Also update any incomplete PEP schedule entries for D14/D28 that shouldn't exist
      const [pepUpdate] = await pool.query(`
        UPDATE patient_pep_schedule 
        SET status = 'Not Required'
        WHERE patient_id = ? 
          AND day_label IN ('Day 14', 'Day 28')
          AND date_given IS NULL
      `, [patient.patient_id]);
      
      if (pepUpdate.affectedRows > 0) {
        console.log(`✅ Marked ${pepUpdate.affectedRows} unnecessary PEP schedule(s) as 'Not Required'`);
      }
      
    } else {
      console.log('\n⚠️  Status unclear:');
      console.log(`   Is Category I? ${isCategory1}`);
      console.log(`   Has all required doses? ${hasAllDoses}`);
      console.log(`   Outcome is C? ${patient.outcome === 'C'}`);
    }
    
    console.log('\n=== Done ===\n');
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

fixBabyAnn();
