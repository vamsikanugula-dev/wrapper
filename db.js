const { Pool } = require('pg');

// Create a connection pool using the Neon DATABASE_URL
console.log('DATABASE_URL:', process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test the database connection
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Connected to Neon PostgreSQL database');
    client.release();
    return true;
  } catch (err) {
    console.error('Failed to connect to Neon PostgreSQL database:', err);
    return false;
  }
}

// Initialize database tables
async function initDatabase() {
  try {
    const client = await pool.connect();

    // Create decks table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS decks (
        id VARCHAR(12) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        theme VARCHAR(50) NOT NULL,
        slides JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index on theme for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decks_theme ON decks(theme)
    `);

    console.log('Database tables initialized');
    client.release();
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

// Deck storage functions using PostgreSQL
async function loadDeck(id) {
  try {
    const result = await pool.query(
      'SELECT * FROM decks WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const deck = result.rows[0];
    return {
      id: deck.id,
      title: deck.title,
      theme: deck.theme,
      slides: deck.slides,
      createdAt: deck.created_at.toISOString()
    };
  } catch (err) {
    console.error('Error loading deck from database:', err);
    return null;
  }
}

async function saveDeck(deck) {
  try {
    await pool.query(
      `
      INSERT INTO decks (id, title, theme, slides, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        theme = EXCLUDED.theme,
        slides = EXCLUDED.slides,
        updated_at = EXCLUDED.updated_at
      `,
      [
        deck.id,
        deck.title,
        deck.theme,
        JSON.stringify(deck.slides),
        new Date(deck.createdAt),
        new Date()
      ]
    );
  } catch (err) {
    console.error('Error saving deck to database:', err);
    throw err;
  }
}

module.exports = {
  pool,
  testConnection,
  initDatabase,
  loadDeck,
  saveDeck
};