import { ExampleConnector } from './index.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Example Update Script
 *
 * This script shows how to:
 * 1. Initialize the database schema
 * 2. Fetch data from an external source (API, CSV, etc.)
 * 3. Transform and store the data
 * 4. Handle errors and logging
 */

async function updateExampleData() {
  console.log('Starting example data update...');

  const connector = new ExampleConnector();

  // Ensure data directory exists
  const dataDir = path.dirname(connector.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`Created directory: ${dataDir}`);
  }

  try {
    // Step 1: Initialize database schema
    console.log('Initializing database schema...');
    await connector.initDatabase();

    // Step 2: Fetch data from external source
    // In a real connector, you would:
    // - Call an API
    // - Read from a CSV file
    // - Connect to another database
    // - etc.
    console.log('Fetching data from source...');
    const exampleData = await fetchDataFromSource();

    // Step 3: Transform and store data
    console.log(`Processing ${exampleData.length} items...`);
    const db = new Database(connector.dbPath);
    try {
      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO items (name, status, created_at)
        VALUES (?, ?, ?)
      `);

      const insert = db.transaction((items) => {
        for (const item of items) {
          insertStmt.run(item.name, item.status, item.created_at);
        }
      });

      insert(exampleData);
      console.log(`Successfully inserted ${exampleData.length} items`);
    } finally {
      db.close();
    }

    // Step 4: Verify results
    const stats = await connector.getStats();
    console.log('Update complete!');
    console.log('Statistics:', JSON.stringify(stats, null, 2));

  } catch (error) {
    console.error('Error updating example data:', error);
    process.exit(1);
  }
}

/**
 * Simulate fetching data from an external source
 * Replace this with your actual data fetching logic
 */
async function fetchDataFromSource() {
  // This is just example data
  // In a real connector, you would fetch from an API, database, etc.
  return [
    {
      name: 'Example Item 1',
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      name: 'Example Item 2',
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      name: 'Example Item 3',
      status: 'inactive',
      created_at: new Date().toISOString()
    }
  ];
}

// Run the update
updateExampleData().catch(console.error);
