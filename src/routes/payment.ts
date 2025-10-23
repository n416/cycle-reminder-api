import { Router, Request } from 'express';
import axios from 'axios';
import { db } from '../config/firebase';
import { protect, AuthRequest } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

const KOMOJU_API_SECRET_KEY = process.env.KOMOJU_SECRET_KEY;
const KOMOJU_WEBHOOK_SECRET = process.env.KOMOJU_WEBHOOK_SECRET;
const KOMOJU_API_BASE_URL = 'https://komoju.com/api/v1';

if (!KOMOJU_API_SECRET_KEY || !KOMOJU_WEBHOOK_SECRET) {
  throw new Error("Komoju secret key or webhook secret is not defined in environment variables.");
}

const plans = {
  monthly: {
    label: '月額プラン',
    initial_amount: 500,
    recurring_amount: 50,
    payment_types: ['credit_card'],
    is_subscription: true,
    komoju_plan_id: 'plan_monthly_F500_50', 
  },
  annual: {
    label: '年間プラン',
    initial_amount: 1500,
    payment_types: ['konbini', 'paypay'],
    is_subscription: false,
  },
};

type PlanId = keyof typeof plans;

function isValidPlanId(id: any): id is PlanId {
  return id in plans;
}

router.post('/create-session', protect, async (req: AuthRequest, res) => {
  const planId: unknown = req.body.planId;
  const userId = req.user.id;

  if (!isValidPlanId(planId)) {
    return res.status(400).json({ error: 'Invalid plan ID' });
  }

  const userRef = db.collection('users').doc(userId);

  try {
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      const status = userData?.subscriptionStatus;

      if (status === 'active') {
        console.log(`--- User ${userId} attempted to purchase, but is already 'active'. ---`);
        return res.status(400).json({ error: 'すでに有効なプランにご加入済みです。' });
      }
      if (status === 'pending') {
        console.log(`--- User ${userId} attempted to purchase, but is already 'pending'. ---`);
        return res.status(400).json({ error: '現在、支払い手続き中のため、新しい決済を開始できません。お支払いをキャンセルする場合は、一度このページに戻ってきて再度お試しください。' });
      }
    }

    const frontendUrl = process.env.NODE_ENV === 'production' 
      ? process.env.FRONTEND_URL_PROD 
      : 'http://localhost:5173';

    if (!frontendUrl) {
        return res.status(500).json({ error: 'Frontend URL is not configured.' });
    }

    const plan = plans[planId];
    let sessionPayload;

    if (plan.is_subscription) {
      sessionPayload = {
        mode: 'customer_payment_subscription', 
        plan: (plan as any).komoju_plan_id,
        amount: plan.initial_amount,
        currency: 'JPY',
        payment_types: plan.payment_types,
        return_url: `${frontendUrl}/payment/success`,
        cancel_url: `${frontendUrl}/payment/cancel`,
        metadata: { user_id: userId, plan_id: planId },
      };
    } else {
      sessionPayload = {
        amount: plan.initial_amount,
        currency: 'JPY',
        payment_types: plan.payment_types,
        return_url: `${frontendUrl}/payment/success`,
        cancel_url: `${frontendUrl}/payment/cancel`,
        metadata: { user_id: userId, plan_id: planId },
      };
    }

    console.log('--- Sending payload to Komoju /sessions ---');
    console.log(JSON.stringify(sessionPayload, null, 2));

    const response = await axios.post(
      `${KOMOJU_API_BASE_URL}/sessions`,
      sessionPayload,
      { auth: { username: KOMOJU_API_SECRET_KEY, password: '' } }
    );
    
    // ここでは 'pending' にしない

    res.status(200).json({ sessionUrl: response.data.session_url });
  } catch (error: any) {
    console.error('!!! An unexpected error occurred while creating Komoju session !!!');
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    res.status(500).json({ error: '決済セッションの作成中に予期せぬエラーが発生しました。時間をおいて再度お試しください。' });
  }
});

router.post('/cancel-pending', protect, async (req: AuthRequest, res) => {
    const userId = req.user.id;
    const userRef = db.collection('users').doc(userId);
    try {
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData?.subscriptionStatus === 'pending') {
                await userRef.set({ subscriptionStatus: 'inactive', pendingSince: null }, { merge: true });
                console.log(`--- User ${userId} status reverted from 'pending' to 'inactive'. ---`);
                return res.status(200).json({ message: 'Pending status has been cancelled.' });
            }
        }
        res.status(200).json({ message: 'No pending status to cancel.' });
    } catch (error: any) {
        console.error(`!!! Failed to cancel pending status for user ${userId}:`, error);
        res.status(500).json({ error: 'Failed to cancel pending status.' });
    }
});

router.post('/webhook', async (req: Request & { rawBody?: Buffer }, res) => {
  const signature = req.headers['x-komoju-signature'] as string;
  const rawBody = req.rawBody; 
  if (!rawBody) return res.status(400).send('Bad request: Raw body missing.');

  const hmac = crypto.createHmac('sha256', KOMOJU_WEBHOOK_SECRET);
  const digest = hmac.update(rawBody).digest('hex'); 

  if (digest !== signature) return res.status(401).send('Invalid signature');
  
  const event = req.body;

  console.log(`--- Received webhook event: ${event.type} ---`);
  console.log(JSON.stringify(event.data, null, 2));

  if (event.type === 'payment.authorized') {
    const payment = event.data;
    const { user_id } = payment.metadata;
    if (user_id) {
      try {
        const userRef = db.collection('users').doc(user_id);
        await userRef.set({
          subscriptionStatus: 'pending',
          pendingSince: new Date(),
        }, { merge: true });
        console.log(`--- User ${user_id} status set to 'pending' via payment.authorized. ---`);
      } catch (error: any) {
        console.error('!!! Webhook processing failed for payment.authorized:', error.message);
      }
    }
  } else if (event.type === 'payment.captured') {
    const payment = event.data;
    const { user_id, plan_id } = payment.metadata;

    if (user_id && isValidPlanId(plan_id)) {
      const userRef = db.collection('users').doc(user_id);
      const plan = plans[plan_id];

      try {
        if (plan.is_subscription) {
          await userRef.set({
            subscriptionStatus: 'active',
            komojuCustomerId: payment.customer, 
            pendingSince: null,
          }, { merge: true });
          console.log(`!!! Subscription status updated for user ${user_id} via payment.captured !!!`);
        } else {
          const expiresAt = new Date();
          expiresAt.setFullYear(expiresAt.getFullYear() + 1);
          await userRef.set({ 
              subscriptionStatus: 'active',
              expiresAt: expiresAt.toISOString(),
              pendingSince: null,
          }, { merge: true });
          console.log(`!!! Firestore write successful for user ${user_id} with one-time plan ${plan_id}. !!!`);
        }
      } catch (error: any) {
        console.error('!!! Webhook processing failed for payment.captured:', error.message);
      }
    }
  }
  
  res.status(200).send('OK');
});

router.post('/cancel-subscription', protect, async (req: AuthRequest, res) => {
    const userId = req.user.id;
    const userRef = db.collection('users').doc(userId);
    try {
        const userDoc = await userRef.get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found.' });
        
        const userData = userDoc.data();
        if (userData?.subscriptionStatus === 'tester') {
            await userRef.set({ subscriptionStatus: 'inactive' }, { merge: true });
            return res.status(200).json({ message: 'Tester mode deactivated.' });
        }
        
        const { komojuSubscriptionId } = userData || {};
        if (komojuSubscriptionId) {
            await axios.delete(`${KOMOJU_API_BASE_URL}/subscriptions/${komojuSubscriptionId}`, {
                auth: { username: KOMOJU_API_SECRET_KEY, password: '' }
            });
        }
        
        await userRef.set({ subscriptionStatus: 'inactive' }, { merge: true });
        res.status(200).json({ message: 'Subscription cancelled.' });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to cancel.' });
    }
});

router.post('/activate-test-mode', protect, async (req: AuthRequest, res) => {
    const userId = req.user.id;
    const TESTER_USER_IDS = (process.env.TESTER_USER_IDS || '').split(',');
    
    if (!TESTER_USER_IDS.includes(userId)) {
        return res.status(403).json({ error: 'Not authorized for tester mode.' });
    }

    const userRef = db.collection('users').doc(userId);
    try {
        await userRef.set({ subscriptionStatus: 'tester' }, { merge: true });
        res.status(200).json({ message: 'Tester mode activated.' });
    } catch (error: any) {
        res.status(500).json({ error: 'Failed to activate.' });
    }
});

export default router;