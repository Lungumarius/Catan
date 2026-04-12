const { Client } = require('pg');

const client = new Client({
  connectionString: "postgresql://postgres.omomjrtwafasftfrsafu:Teofana3290Catan@aws-1-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require",
});

async function test() {
  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected!');
    const res = await client.query('SELECT NOW()');
    console.log('Result:', res.rows[0]);
    await client.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

test();
