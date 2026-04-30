-- =============================================================================
-- SUREVIDEOTOOL — FULL DATABASE SETUP
-- Run this ONCE on a brand-new Supabase project (SQL Editor → New Query → Run).
-- Idempotent: safe to re-run.
--
-- BEFORE RUNNING:
--   1) Authentication → Users → "Add user"
--        email:    Cyrilreed4@gmail.com
--        password: Secure1234
--        Auto Confirm: YES
--   2) Then run this whole file. The seed at the bottom will promote that
--      auth user into the admins table by email lookup.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. TABLES
-- =============================================================================

-- ---- 1.1 USERS (mirrors auth.users)
CREATE TABLE IF NOT EXISTS public.users (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           TEXT UNIQUE NOT NULL,
    is_blocked      BOOLEAN DEFAULT FALSE,
    blocked_reason  TEXT,
    blocked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ---- 1.2 WALLETS
CREATE TABLE IF NOT EXISTS public.wallets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID UNIQUE NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    credits     INTEGER DEFAULT 0 CHECK (credits >= 0),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- ---- 1.3 TRANSACTIONS
CREATE TABLE IF NOT EXISTS public.transactions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL CHECK (type IN ('credit_purchase', 'usage', 'admin_adjustment')),
    amount_naira  NUMERIC(12, 2) DEFAULT 0,
    credits       INTEGER NOT NULL DEFAULT 0,
    reference     TEXT,
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id     ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at  ON public.transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type        ON public.transactions(type);

-- ---- 1.4 SESSIONS
CREATE TABLE IF NOT EXISTS public.sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    start_time    TIMESTAMPTZ DEFAULT NOW(),
    end_time      TIMESTAMPTZ,
    credits_used  INTEGER DEFAULT 0,
    seconds_used  INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status     ON public.sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON public.sessions(created_at DESC);

-- ---- 1.5 PLANS
CREATE TABLE IF NOT EXISTS public.plans (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    credits     INTEGER NOT NULL DEFAULT 0,
    usd_price   NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---- 1.6 SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_name    TEXT NOT NULL,
    amount_paid  NUMERIC(12, 2) DEFAULT 0,
    credits      INTEGER NOT NULL,
    status       TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status  ON public.subscriptions(status);

-- ---- 1.7 EXCHANGE RATES
CREATE TABLE IF NOT EXISTS public.exchange_rates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency   TEXT NOT NULL DEFAULT 'USD',
    to_currency     TEXT NOT NULL DEFAULT 'NGN',
    rate            NUMERIC(12, 4) NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_currency, to_currency)
);

-- ---- 1.8 ADMINS
CREATE TABLE IF NOT EXISTS public.admins (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---- 1.9 CREDIT ADJUSTMENTS (audit of admin credit edits)
CREATE TABLE IF NOT EXISTS public.credit_adjustments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    admin_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    delta        INTEGER NOT NULL,
    new_balance  INTEGER NOT NULL,
    reason       TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_adjustments_user ON public.credit_adjustments(user_id);

-- ---- 1.10 AUDIT LOG (general admin actions)
CREATE TABLE IF NOT EXISTS public.audit_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target_table  TEXT,
    target_id     TEXT,
    payload       JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log(created_at DESC);

-- =============================================================================
-- 2. TRIGGERS
-- =============================================================================

-- 2.1 Mirror auth.users → public.users on signup
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.users (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 2.2 Auto-create wallet for every new public.users row
CREATE OR REPLACE FUNCTION public.create_wallet_for_user()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.wallets (user_id, credits)
    VALUES (NEW.id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_wallet ON public.users;
CREATE TRIGGER trg_create_wallet
    AFTER INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.create_wallet_for_user();

-- 2.3 Validate credits never go negative
CREATE OR REPLACE FUNCTION public.validate_credits_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.credits < 0 THEN RAISE EXCEPTION 'Credits cannot be negative'; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_credits ON public.wallets;
CREATE TRIGGER trg_validate_credits
    BEFORE UPDATE ON public.wallets
    FOR EACH ROW EXECUTE FUNCTION public.validate_credits_update();

-- =============================================================================
-- 3. CORE FUNCTIONS (used by API)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_credits(p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_credits INTEGER;
BEGIN
    SELECT credits INTO v_credits FROM public.wallets WHERE user_id = p_user_id;
    RETURN COALESCE(v_credits, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id UUID, p_deduct INTEGER)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current INTEGER; v_final INTEGER; v_new INTEGER;
BEGIN
    SELECT credits INTO v_current FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    v_final := LEAST(COALESCE(v_current, 0), p_deduct);
    v_new   := GREATEST(0, COALESCE(v_current, 0) - v_final);
    UPDATE public.wallets SET credits = v_new WHERE user_id = p_user_id;
    RETURN json_build_object('success', TRUE, 'credits_deducted', v_final, 'remaining_credits', v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_credits(
    p_user_id UUID, p_credits INTEGER,
    p_amount NUMERIC DEFAULT 0,
    p_ref TEXT DEFAULT NULL,
    p_plan TEXT DEFAULT 'Credit Purchase'
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new INTEGER;
BEGIN
    INSERT INTO public.wallets (user_id, credits) VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.wallets SET credits = credits + p_credits
     WHERE user_id = p_user_id RETURNING credits INTO v_new;

    INSERT INTO public.transactions (user_id, type, amount_naira, credits, reference, description)
    VALUES (p_user_id, 'credit_purchase', p_amount, p_credits, p_ref, p_plan || ' purchased');

    INSERT INTO public.subscriptions (user_id, plan_name, amount_paid, credits, status)
    VALUES (p_user_id, p_plan, p_amount, p_credits, 'active');

    RETURN json_build_object('success', TRUE, 'credits_added', p_credits, 'new_credits', v_new);
END;
$$;

-- =============================================================================
-- 4. ADMIN HELPERS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_admin(p_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = p_user);
$$;

-- Frontend-callable RPC. The client gets a boolean, but the server decides.
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.is_admin(auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated, anon;

-- =============================================================================
-- 5. ADMIN RPCs (every one re-checks is_admin server-side)
-- =============================================================================

-- 5.1 List users with credits + status
CREATE OR REPLACE FUNCTION public.admin_list_users(
    p_search TEXT DEFAULT NULL,
    p_limit  INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id              UUID,
    email           TEXT,
    credits         INTEGER,
    is_blocked      BOOLEAN,
    blocked_reason  TEXT,
    created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;

    RETURN QUERY
    SELECT u.id, u.email,
           COALESCE(w.credits, 0)        AS credits,
           COALESCE(u.is_blocked, FALSE) AS is_blocked,
           u.blocked_reason,
           u.created_at
      FROM public.users u
      LEFT JOIN public.wallets w ON w.user_id = u.id
     WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%'
     ORDER BY u.created_at DESC
     LIMIT p_limit OFFSET p_offset;
END;
$$;

-- 5.2 Set credits to absolute value
CREATE OR REPLACE FUNCTION public.admin_set_credits(
    p_user_id UUID,
    p_credits INTEGER,
    p_reason  TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_admin   UUID := auth.uid();
    v_current INTEGER;
    v_delta   INTEGER;
BEGIN
    IF NOT public.is_admin(v_admin)  THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF p_credits < 0                 THEN RAISE EXCEPTION 'Credits cannot be negative'; END IF;

    INSERT INTO public.wallets (user_id, credits) VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT credits INTO v_current FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    v_delta := p_credits - COALESCE(v_current, 0);

    UPDATE public.wallets SET credits = p_credits WHERE user_id = p_user_id;

    INSERT INTO public.credit_adjustments (user_id, admin_id, delta, new_balance, reason)
    VALUES (p_user_id, v_admin, v_delta, p_credits, p_reason);

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'set_credits', 'wallets', p_user_id::TEXT,
            json_build_object('delta', v_delta, 'new_balance', p_credits, 'reason', p_reason));

    RETURN json_build_object('success', TRUE, 'new_credits', p_credits, 'delta', v_delta);
END;
$$;

-- 5.3 Block / unblock
CREATE OR REPLACE FUNCTION public.admin_set_blocked(
    p_user_id UUID,
    p_blocked BOOLEAN,
    p_reason  TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin UUID := auth.uid();
BEGIN
    IF NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'Not authorized'; END IF;

    UPDATE public.users
       SET is_blocked     = p_blocked,
           blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
           blocked_at     = CASE WHEN p_blocked THEN NOW()    ELSE NULL END
     WHERE id = p_user_id;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin,
            CASE WHEN p_blocked THEN 'block_user' ELSE 'unblock_user' END,
            'users', p_user_id::TEXT,
            json_build_object('reason', p_reason));

    RETURN json_build_object('success', TRUE, 'is_blocked', p_blocked);
END;
$$;

-- 5.4 Upsert plan
CREATE OR REPLACE FUNCTION public.admin_upsert_plan(
    p_id        UUID,
    p_name      TEXT,
    p_credits   INTEGER,
    p_usd_price NUMERIC
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin UUID := auth.uid(); v_id UUID;
BEGIN
    IF NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'Not authorized'; END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.plans (name, credits, usd_price)
        VALUES (p_name, p_credits, p_usd_price) RETURNING id INTO v_id;
    ELSE
        UPDATE public.plans
           SET name = p_name, credits = p_credits, usd_price = p_usd_price
         WHERE id = p_id RETURNING id INTO v_id;
    END IF;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'upsert_plan', 'plans', v_id::TEXT,
            json_build_object('name', p_name, 'credits', p_credits, 'usd_price', p_usd_price));

    RETURN json_build_object('success', TRUE, 'id', v_id);
END;
$$;

-- 5.5 Delete plan
CREATE OR REPLACE FUNCTION public.admin_delete_plan(p_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin UUID := auth.uid();
BEGIN
    IF NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'Not authorized'; END IF;

    DELETE FROM public.plans WHERE id = p_id;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'delete_plan', 'plans', p_id::TEXT, '{}'::JSONB);

    RETURN json_build_object('success', TRUE);
END;
$$;

-- 5.6 Dashboard stats
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSON;
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;

    SELECT json_build_object(
        'total_users',     (SELECT COUNT(*) FROM public.users),
        'blocked_users',   (SELECT COUNT(*) FROM public.users WHERE is_blocked),
        'total_credits',   (SELECT COALESCE(SUM(credits),0) FROM public.wallets),
        'total_revenue',   (SELECT COALESCE(SUM(amount_naira),0) FROM public.transactions WHERE type='credit_purchase'),
        'active_sessions', (SELECT COUNT(*) FROM public.sessions WHERE status='active')
    ) INTO v;
    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users(TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_credits(UUID, INTEGER, TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_blocked(UUID, BOOLEAN, TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_plan(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_plan(UUID)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stats()                           TO authenticated;

-- =============================================================================
-- 6. ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_adjustments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log           ENABLE ROW LEVEL SECURITY;

-- Drop any prior policies (idempotent)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('users','wallets','transactions','sessions','plans',
                         'subscriptions','exchange_rates','admins',
                         'credit_adjustments','audit_log')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ---- USERS
CREATE POLICY "users_select"  ON public.users
  FOR SELECT USING (auth.uid() = id OR public.is_admin());
CREATE POLICY "users_update"  ON public.users
  FOR UPDATE USING (auth.uid() = id OR public.is_admin())
  WITH CHECK (auth.uid() = id OR public.is_admin());

-- ---- WALLETS
CREATE POLICY "wallets_select" ON public.wallets
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "wallets_update" ON public.wallets
  FOR UPDATE USING (auth.uid() = user_id OR public.is_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin());

-- ---- TRANSACTIONS
CREATE POLICY "tx_select" ON public.transactions
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "tx_insert" ON public.transactions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.is_admin());

-- ---- SESSIONS
CREATE POLICY "sessions_select" ON public.sessions
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "sessions_insert" ON public.sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sessions_update" ON public.sessions
  FOR UPDATE USING (auth.uid() = user_id OR public.is_admin());

-- ---- PLANS  (everyone reads, only admins write)
CREATE POLICY "plans_select" ON public.plans
  FOR SELECT USING (TRUE);
CREATE POLICY "plans_admin_all" ON public.plans
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---- SUBSCRIPTIONS
CREATE POLICY "subs_select" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "subs_insert" ON public.subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.is_admin());

-- ---- EXCHANGE RATES (public read, admin write)
CREATE POLICY "rates_select" ON public.exchange_rates
  FOR SELECT USING (TRUE);
CREATE POLICY "rates_admin_all" ON public.exchange_rates
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---- ADMINS  (a user can see only their own admin record)
CREATE POLICY "admins_self" ON public.admins
  FOR SELECT USING (auth.uid() = user_id);

-- ---- CREDIT ADJUSTMENTS  (admins only)
CREATE POLICY "adj_admin_select" ON public.credit_adjustments
  FOR SELECT USING (public.is_admin());

-- ---- AUDIT LOG  (admins only)
CREATE POLICY "audit_admin_select" ON public.audit_log
  FOR SELECT USING (public.is_admin());

-- =============================================================================
-- 7. SEED DATA
-- =============================================================================

-- 7.1 Default plans
INSERT INTO public.plans (name, credits, usd_price) VALUES
    ('Starter',     500,  10.00),
    ('Basic',      1000,  20.00),
    ('Pro',        2000,  40.00),
    ('Enterprise', 5000, 100.00)
ON CONFLICT DO NOTHING;

-- 7.2 Default exchange rate
INSERT INTO public.exchange_rates (from_currency, to_currency, rate)
VALUES ('USD', 'NGN', 1500.0000)
ON CONFLICT (from_currency, to_currency) DO UPDATE
SET rate = EXCLUDED.rate, updated_at = NOW();

-- 7.3 Backfill any existing auth users into public.users + wallets
INSERT INTO public.users (id, email)
SELECT au.id, au.email FROM auth.users au
LEFT JOIN public.users u ON u.id = au.id
WHERE u.id IS NULL;

INSERT INTO public.wallets (user_id, credits)
SELECT u.id, 0 FROM public.users u
LEFT JOIN public.wallets w ON w.user_id = u.id
WHERE w.user_id IS NULL;

-- 7.4 Promote the admin account by email lookup
--      (You must have created the auth user Cyrilreed4@gmail.com first.)
INSERT INTO public.admins (user_id, email)
SELECT id, email FROM auth.users
WHERE LOWER(email) = LOWER('Cyrilreed4@gmail.com')
ON CONFLICT (user_id) DO NOTHING;

-- =============================================================================
-- DONE
-- =============================================================================
