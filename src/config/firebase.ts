// src/config/firebase.ts

import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// --- ★★★ ここからデバッグコードを復活 ★★★ ---
console.log('--- DEBUG START ---');

const encodedServiceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

console.log('1. Reading GOOGLE_APPLICATION_CREDENTIALS_BASE64:',
  encodedServiceAccount ? `Found ${encodedServiceAccount.length} characters.` : 'Not found.');
console.log('2. Reading GOOGLE_APPLICATION_CREDENTIALS (for local dev):',
  credentialPath ? `Found value: ${credentialPath}` : 'Not found.');
// --- ★★★ ここまでデバッグコードを復活 ★★★ ---


if (encodedServiceAccount) {
  try {
    console.log('3. Attempting to decode Base64 string...');
    const serviceAccountJson = Buffer.from(encodedServiceAccount, 'base64').toString('utf-8');
    console.log('4. Decoding successful. Attempting to parse JSON...');
    const serviceAccount = JSON.parse(serviceAccountJson);
    console.log('5. JSON parsing successful. Initializing Firebase...');

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('6. Firebase initialized successfully via Base64.');

  } catch (error: any) {
    console.error('--- ERROR DURING BASE64 PROCESSING ---');
    console.error(error);
    throw error; // エラーでプロセスを停止
  }

} else if (credentialPath) {
  try {
    console.log('3. Attempting to initialize Firebase via file path (for local dev)...');
    admin.initializeApp({
      credential: admin.credential.cert(credentialPath),
    });
    console.log('4. Firebase initialized successfully via file path.');
  } catch (error: any) {
    console.error('--- ERROR DURING FILE PATH PROCESSING ---');
    console.error(error);
    throw error; // エラーでプロセスを停止
  }
} else {
  throw new Error(
    'Either GOOGLE_APPLICATION_CREDENTIALS_BASE64 or GOOGLE_APPLICATION_CREDENTIALS must be set.'
  );
}

console.log('--- DEBUG END: Firebase config loaded successfully. ---');

export const db = admin.firestore();