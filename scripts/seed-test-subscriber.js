const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const EMAIL = 'test@walesz.pl';
const CODE  = 'TEST-WALE-2025';
const PLAN  = 'vip';
const NAME  = 'Test VIP';

const codeHash = crypto.createHash('sha256').update(CODE.toLowerCase().trim()).digest('hex');

async function main() {
  await pool.query(`
    INSERT INTO subscribers (email, name, plan, code_hash)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (email) DO UPDATE SET code_hash = $4, plan = $3, status = 'active'
  `, [EMAIL, NAME, PLAN, codeHash]);

  console.log('\n✓ Test subscriber created / updated\n');
  console.log('  Email: ' + EMAIL);
  console.log('  Code:  ' + CODE);
  console.log('  Plan:  ' + PLAN);
  console.log('\nURL: /subscriber\n');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
