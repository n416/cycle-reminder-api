import admin from 'firebase-admin';
import dotenv from 'dotenv';

// 最初に環境変数を読み込む
dotenv.config();

const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!credentialPath) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set or .env file is missing.');
}

// 環境変数から取得したファイルパスを使って初期化
admin.initializeApp({
  credential: admin.credential.cert(credentialPath),
});

// Firestoreのインスタンスをエクスポート
export const db = admin.firestore();