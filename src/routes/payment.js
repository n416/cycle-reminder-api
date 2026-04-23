import { Hono } from 'hono';
import { protect } from '../middleware/auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
const paymentRouter = new Hono();
const KOMOJU_API_BASE_URL = 'https://komoju.com/api/v1';
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
function isValidPlanId(id) {
    return id in plans;
}
paymentRouter.post('/create-session', protect, async (c) => {
    const body = await c.req.json();
    const planId = body.planId;
    const userId = c.get('user').id;
    if (!isValidPlanId(planId)) {
        return c.json({ error: 'Invalid plan ID' }, 400);
    }
    const db = drizzle(c.env.DB, { schema });
    try {
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        if (userDoc) {
            const status = userDoc.subscriptionStatus;
            if (status === 'active') {
                return c.json({ error: 'すでに有効なプランにご加入済みです。' }, 400);
            }
            if (status === 'pending') {
                return c.json({ error: '現在、支払い手続き中のため、新しい決済を開始できません。' }, 400);
            }
        }
        const frontendUrl = c.env.FRONTEND_URL;
        if (!frontendUrl) {
            return c.json({ error: 'Frontend URL is not configured.' }, 500);
        }
        const plan = plans[planId];
        let sessionPayload;
        if (plan.is_subscription) {
            sessionPayload = {
                mode: 'customer_payment_subscription',
                plan: plan.komoju_plan_id,
                amount: plan.initial_amount,
                currency: 'JPY',
                payment_types: plan.payment_types,
                return_url: `${frontendUrl}/payment/success`,
                cancel_url: `${frontendUrl}/payment/cancel`,
                metadata: { user_id: userId, plan_id: planId },
            };
        }
        else {
            sessionPayload = {
                amount: plan.initial_amount,
                currency: 'JPY',
                payment_types: plan.payment_types,
                return_url: `${frontendUrl}/payment/success`,
                cancel_url: `${frontendUrl}/payment/cancel`,
                metadata: { user_id: userId, plan_id: planId },
            };
        }
        // Edge-compatible base64 encoding for basic auth
        const basicAuth = btoa(`${c.env.KOMOJU_SECRET_KEY}:`);
        const response = await fetch(`${KOMOJU_API_BASE_URL}/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${basicAuth}`
            },
            body: JSON.stringify(sessionPayload)
        });
        if (!response.ok) {
            throw new Error(`Komoju API error: ${response.statusText}`);
        }
        const data = await response.json();
        return c.json({ sessionUrl: data.session_url });
    }
    catch (error) {
        console.error('!!! An unexpected error occurred while creating Komoju session !!!', error);
        return c.json({ error: '決済セッションの作成中に予期せぬエラーが発生しました。' }, 500);
    }
});
paymentRouter.get('/session-status/:sessionId', protect, async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!sessionId)
        return c.json({ error: 'Session ID is required.' }, 400);
    try {
        const basicAuth = btoa(`${c.env.KOMOJU_SECRET_KEY}:`);
        const response = await fetch(`${KOMOJU_API_BASE_URL}/sessions/${sessionId}`, {
            headers: { 'Authorization': `Basic ${basicAuth}` }
        });
        if (!response.ok)
            throw new Error('Komoju API error');
        const sessionData = await response.json();
        return c.json({
            status: sessionData.status,
            paymentStatus: sessionData.payment?.status,
        });
    }
    catch (error) {
        return c.json({ error: 'Failed to fetch session status.' }, 500);
    }
});
paymentRouter.post('/cancel-pending', protect, async (c) => {
    const userId = c.get('user').id;
    const db = drizzle(c.env.DB, { schema });
    try {
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        if (userDoc && userDoc.subscriptionStatus === 'pending') {
            await db.update(schema.users).set({ subscriptionStatus: 'inactive' }).where(eq(schema.users.id, userId));
            return c.json({ message: 'Pending status has been cancelled.' });
        }
        return c.json({ message: 'No pending status to cancel.' });
    }
    catch (error) {
        return c.json({ error: 'Failed to cancel pending status.' }, 500);
    }
});
paymentRouter.post('/webhook', async (c) => {
    const signature = c.req.header('x-komoju-signature');
    const rawBody = await c.req.text();
    if (!rawBody || !signature)
        return c.text('Bad request', 400);
    // Web Crypto API HMAC Verification
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(c.env.KOMOJU_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const signatureBuffer = new Uint8Array(signature.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const isValid = await crypto.subtle.verify('HMAC', key, signatureBuffer, encoder.encode(rawBody));
    if (!isValid)
        return c.text('Invalid signature', 401);
    const event = JSON.parse(rawBody);
    const db = drizzle(c.env.DB, { schema });
    if (event.type === 'payment.authorized') {
        const payment = event.data;
        const { user_id } = payment.metadata;
        if (user_id) {
            try {
                await db.update(schema.users).set({ subscriptionStatus: 'pending' }).where(eq(schema.users.id, user_id));
            }
            catch (error) {
                console.error('Webhook processing failed for payment.authorized:', error.message);
            }
        }
    }
    else if (event.type === 'payment.captured') {
        const payment = event.data;
        const { user_id, plan_id } = payment.metadata;
        if (user_id && isValidPlanId(plan_id)) {
            const plan = plans[plan_id];
            try {
                if (plan.is_subscription) {
                    await db.update(schema.users).set({ subscriptionStatus: 'active' }).where(eq(schema.users.id, user_id));
                }
                else {
                    const expiresAt = new Date();
                    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
                    await db.update(schema.users).set({
                        subscriptionStatus: 'active',
                        expiresAt: expiresAt.toISOString()
                    }).where(eq(schema.users.id, user_id));
                }
            }
            catch (error) {
                console.error('Webhook processing failed for payment.captured:', error.message);
            }
        }
    }
    return c.text('OK');
});
paymentRouter.post('/cancel-subscription', protect, async (c) => {
    const userId = c.get('user').id;
    const db = drizzle(c.env.DB, { schema });
    try {
        const userDoc = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
        if (!userDoc)
            return c.json({ error: 'User not found.' }, 404);
        await db.update(schema.users).set({ subscriptionStatus: 'inactive' }).where(eq(schema.users.id, userId));
        return c.json({ message: 'Subscription status has been set to inactive.' });
    }
    catch (error) {
        return c.json({ error: 'Failed to cancel.' }, 500);
    }
});
export default paymentRouter;
