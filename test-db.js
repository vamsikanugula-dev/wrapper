require('dotenv').config();
const { testConnection, initDatabase, loadDeck, saveDeck } = require('./db');

// Test database connection and operations
async function testDB() {
  console.log('Testing database connection...');

  const connected = await testConnection();
  if (!connected) {
    console.error('Failed to connect to database');
    return;
  }

  console.log('Connected to database successfully');

  // Initialize tables
  await initDatabase();
  console.log('Database tables initialized');

  // Test saving a deck with a 12-character ID
  const testDeck = {
    id: 'abcdefghijk1', // 12 characters
    title: 'Test Deck',
    theme: 'ocean',
    slides: [
      { title: 'Slide 1', content: ['Point 1', 'Point 2', 'Point 3'] },
      { title: 'Slide 2', content: ['Point A', 'Point B', 'Point C'] }
    ],
    createdAt: new Date().toISOString()
  };

  console.log('Test deck ID:', testDeck.id);
  console.log('Test deck ID length:', testDeck.id.length);

  try {
    await saveDeck(testDeck);
    console.log('Test deck saved successfully');

    // Test loading the deck
    const loadedDeck = await loadDeck(testDeck.id);
    if (loadedDeck) {
      console.log('Test deck loaded successfully:', loadedDeck.title);
    } else {
      console.error('Failed to load test deck');
    }

    // Clean up - we could delete it but let's leave it for now
    console.log('Database test completed successfully');
  } catch (error) {
    console.error('Error during deck operations:', error);
  }
}

testDB().catch(console.error);