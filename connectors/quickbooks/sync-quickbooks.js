#!/usr/bin/env node

/**
 * QuickBooks Complete Sync
 * Syncs all QuickBooks data to local SQLite database
 */

import { QuickBooksConnector } from './index.js';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '..', '..', 'data', 'quickbooks', 'quickbooks.db');

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncQuickBooks() {
  console.log('🚀 Starting QuickBooks sync...\n');

  const qb = new QuickBooksConnector();
  await qb.initialize();

  const db = new Database(DB_PATH);
  console.log(`📁 Database: ${DB_PATH}\n`);

  try {
    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        Id TEXT PRIMARY KEY,
        DisplayName TEXT,
        GivenName TEXT,
        FamilyName TEXT,
        CompanyName TEXT,
        PrimaryEmailAddr TEXT,
        PrimaryPhone TEXT,
        Balance REAL,
        Active INTEGER,
        CreateTime TEXT,
        LastUpdatedTime TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS invoices (
        Id TEXT PRIMARY KEY,
        DocNumber TEXT,
        CustomerRef TEXT,
        CustomerName TEXT,
        TxnDate TEXT,
        DueDate TEXT,
        TotalAmt REAL,
        Balance REAL,
        EmailStatus TEXT,
        CreateTime TEXT,
        LastUpdatedTime TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS payments (
        Id TEXT PRIMARY KEY,
        CustomerRef TEXT,
        CustomerName TEXT,
        TxnDate TEXT,
        TotalAmt REAL,
        UnappliedAmt REAL,
        CreateTime TEXT,
        LastUpdatedTime TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS items (
        Id TEXT PRIMARY KEY,
        Name TEXT,
        Type TEXT,
        Description TEXT,
        UnitPrice REAL,
        Active INTEGER,
        CreateTime TEXT,
        LastUpdatedTime TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS accounts (
        Id TEXT PRIMARY KEY,
        Name TEXT,
        AccountType TEXT,
        AccountSubType TEXT,
        CurrentBalance REAL,
        Active INTEGER,
        CreateTime TEXT,
        LastUpdatedTime TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_time TEXT,
        entity_type TEXT,
        records_synced INTEGER,
        status TEXT
      );
    `);

    // Sync customers
    console.log('👥 Syncing customers...');
    const customersResult = await qb.query('SELECT * FROM Customer MAXRESULTS 1000');
    const customers = customersResult.QueryResponse?.Customer || [];

    const insertCustomer = db.prepare(`
      INSERT OR REPLACE INTO customers
      (Id, DisplayName, GivenName, FamilyName, CompanyName, PrimaryEmailAddr, PrimaryPhone, Balance, Active, CreateTime, LastUpdatedTime, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of customers) {
      insertCustomer.run(
        c.Id,
        c.DisplayName,
        c.GivenName,
        c.FamilyName,
        c.CompanyName,
        c.PrimaryEmailAddr?.Address,
        c.PrimaryPhone?.FreeFormNumber,
        c.Balance,
        c.Active ? 1 : 0,
        c.MetaData?.CreateTime,
        c.MetaData?.LastUpdatedTime,
        JSON.stringify(c)
      );
    }
    console.log(`   ✅ Synced ${customers.length} customers`);
    await delay(2000);

    // Sync invoices
    console.log('📄 Syncing invoices...');
    const invoicesResult = await qb.query('SELECT * FROM Invoice MAXRESULTS 1000');
    const invoices = invoicesResult.QueryResponse?.Invoice || [];

    const insertInvoice = db.prepare(`
      INSERT OR REPLACE INTO invoices
      (Id, DocNumber, CustomerRef, CustomerName, TxnDate, DueDate, TotalAmt, Balance, EmailStatus, CreateTime, LastUpdatedTime, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const i of invoices) {
      insertInvoice.run(
        i.Id,
        i.DocNumber,
        i.CustomerRef?.value,
        i.CustomerRef?.name,
        i.TxnDate,
        i.DueDate,
        i.TotalAmt,
        i.Balance,
        i.EmailStatus,
        i.MetaData?.CreateTime,
        i.MetaData?.LastUpdatedTime,
        JSON.stringify(i)
      );
    }
    console.log(`   ✅ Synced ${invoices.length} invoices`);
    await delay(2000);

    // Sync payments
    console.log('💳 Syncing payments...');
    const paymentsResult = await qb.query('SELECT * FROM Payment MAXRESULTS 1000');
    const payments = paymentsResult.QueryResponse?.Payment || [];

    const insertPayment = db.prepare(`
      INSERT OR REPLACE INTO payments
      (Id, CustomerRef, CustomerName, TxnDate, TotalAmt, UnappliedAmt, CreateTime, LastUpdatedTime, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of payments) {
      insertPayment.run(
        p.Id,
        p.CustomerRef?.value,
        p.CustomerRef?.name,
        p.TxnDate,
        p.TotalAmt,
        p.UnappliedAmt,
        p.MetaData?.CreateTime,
        p.MetaData?.LastUpdatedTime,
        JSON.stringify(p)
      );
    }
    console.log(`   ✅ Synced ${payments.length} payments`);
    await delay(2000);

    // Sync items
    console.log('📦 Syncing items...');
    const itemsResult = await qb.query('SELECT * FROM Item MAXRESULTS 1000');
    const items = itemsResult.QueryResponse?.Item || [];

    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO items
      (Id, Name, Type, Description, UnitPrice, Active, CreateTime, LastUpdatedTime, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insertItem.run(
        item.Id,
        item.Name,
        item.Type,
        item.Description,
        item.UnitPrice,
        item.Active ? 1 : 0,
        item.MetaData?.CreateTime,
        item.MetaData?.LastUpdatedTime,
        JSON.stringify(item)
      );
    }
    console.log(`   ✅ Synced ${items.length} items`);
    await delay(2000);

    // Sync accounts
    console.log('📊 Syncing accounts...');
    const accountsResult = await qb.query('SELECT * FROM Account MAXRESULTS 1000');
    const accounts = accountsResult.QueryResponse?.Account || [];

    const insertAccount = db.prepare(`
      INSERT OR REPLACE INTO accounts
      (Id, Name, AccountType, AccountSubType, CurrentBalance, Active, CreateTime, LastUpdatedTime, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of accounts) {
      insertAccount.run(
        a.Id,
        a.Name,
        a.AccountType,
        a.AccountSubType,
        a.CurrentBalance,
        a.Active ? 1 : 0,
        a.MetaData?.CreateTime,
        a.MetaData?.LastUpdatedTime,
        JSON.stringify(a)
      );
    }
    console.log(`   ✅ Synced ${accounts.length} accounts`);

    // Log the sync
    db.prepare(`
      INSERT INTO sync_log (sync_time, entity_type, records_synced, status)
      VALUES (datetime('now'), 'all', ?, 'success')
    `).run(customers.length + invoices.length + payments.length + items.length + accounts.length);

    console.log('\n✅ QuickBooks sync complete!');
    console.log(`   Customers: ${customers.length}`);
    console.log(`   Invoices: ${invoices.length}`);
    console.log(`   Payments: ${payments.length}`);
    console.log(`   Items: ${items.length}`);
    console.log(`   Accounts: ${accounts.length}`);

  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    throw error;
  } finally {
    db.close();
  }
}

syncQuickBooks().catch(console.error);
