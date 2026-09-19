import pg from 'pg';
// DATE is a calendar key, never a local-midnight JavaScript Date.
pg.types.setTypeParser(1082, (value) => value);
export const database = new pg.Pool({
  options: '-c timezone=UTC',
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 3000,
  statement_timeout: 15000,
  application_name: 'seapro',
});
export const databaseStatus = { connected: false, error: null as string | null };
database.on('error', () => {
  databaseStatus.connected = false;
  databaseStatus.error = 'Andmebaasiühendus katkes';
});
export async function checkDatabase(): Promise<void> {
  try {
    await database.query('SELECT 1 FROM schema_migrations LIMIT 1');
    databaseStatus.connected = true;
    databaseStatus.error = null;
  } catch (error) {
    databaseStatus.connected = false;
    databaseStatus.error = 'Andmebaas ei ole kättesaadav või migreeritud';
    throw error;
  }
}
