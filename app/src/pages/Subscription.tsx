import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Coins, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';

type CreditPlan = {
  credits: number;
  priceNGN: number;
};

type PaymentPointBankAccount = {
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  bankName?: string;
  Reserved_Account_Id?: string;
};

type PaymentPointVirtualAccountResponse = {
  message?: string;
  reused?: boolean;
  cachedAt?: string | null;
  customer?: {
    customer_id?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone_number?: string;
  };
  business?: {
    business_name?: string;
    business_email?: string;
    business_phone_number?: string;
    business_Id?: string | null;
  };
  bankAccounts: PaymentPointBankAccount[];
  amountNGN?: number;
  credits?: number;
};

function resolveConfigValue(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return '';
}

function resolvePaymentPointCheckoutUrl(): string {
  return resolveConfigValue([
    import.meta.env.VITE_PAYMENTPOINT_CHECKOUT_URL,
    import.meta.env.VITE_PAYMENTPOINT_URL,
    import.meta.env.PAYMENTPOINT_CHECKOUT_URL,
  ]);
}

function resolvePaymentPointAccountName(): string {
  return resolveConfigValue([
    import.meta.env.VITE_PAYMENTPOINT_ACCOUNT_NAME,
    import.meta.env.PAYMENTPOINT_ACCOUNT_NAME,
  ]);
}

function resolvePaymentPointAccountNumber(): string {
  return resolveConfigValue([
    import.meta.env.VITE_PAYMENTPOINT_ACCOUNT_NUMBER,
    import.meta.env.PAYMENTPOINT_ACCOUNT_NUMBER,
  ]);
}

function resolvePaymentPointBankName(): string {
  return resolveConfigValue([
    import.meta.env.VITE_PAYMENTPOINT_BANK_NAME,
    import.meta.env.PAYMENTPOINT_BANK_NAME,
  ]);
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/\D/g, '');
}

function buildPaymentInstructions({
  plan,
  email,
  phoneNumber,
  bankAccounts,
  checkoutUrl,
  accountName,
  accountNumber,
  bankName,
}: {
  plan: CreditPlan;
  email: string;
  phoneNumber?: string;
  bankAccounts?: PaymentPointBankAccount[];
  checkoutUrl: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
}) {
  const lines = [
    'Surevideotool PaymentPoint Top-up',
    `Credits: ${plan.credits.toLocaleString()}`,
    `Amount: NGN ${plan.priceNGN.toLocaleString()}`,
    `Use this email in PaymentPoint: ${email}`,
    phoneNumber ? `Phone Number: ${phoneNumber}` : null,
    'Transfer the exact amount into the reserved account below.',
    'Credits are added automatically after PaymentPoint sends a successful webhook.',
  ].filter(Boolean) as string[];

  if (Array.isArray(bankAccounts) && bankAccounts.length > 0) {
    bankAccounts.forEach((bankAccount, index) => {
      lines.push(`Reserved Account ${index + 1}:`);
      if (bankAccount.accountName) {
        lines.push(`Account Name: ${bankAccount.accountName}`);
      }
      if (bankAccount.accountNumber) {
        lines.push(`Account Number: ${bankAccount.accountNumber}`);
      }
      if (bankAccount.bankName) {
        lines.push(`Bank: ${bankAccount.bankName}`);
      }
    });
  }

  if (checkoutUrl) {
    lines.push(`Checkout URL: ${checkoutUrl}`);
  }

  if ((!bankAccounts || bankAccounts.length === 0) && accountName && accountNumber && bankName) {
    lines.push(`Account Name: ${accountName}`);
    lines.push(`Account Number: ${accountNumber}`);
    lines.push(`Bank: ${bankName}`);
  }

  return lines.join('\n');
}

const CREDIT_PLANS = [
  { credits: 500, priceNGN: 11500 },
  { credits: 1000, priceNGN: 23000 },
  { credits: 2000, priceNGN: 46000 },
  { credits: 5000, priceNGN: 115000 },
];

function formatTime(credits: number): string {
  const seconds = credits / CREDITS_PER_SECOND;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `~${minutes}m ${remainingSeconds}s`;
  }

  return `~${remainingSeconds}s`;
}

function Subscription() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCheckingPayment, setIsCheckingPayment] = useState(false);
  const [virtualAccountData, setVirtualAccountData] = useState<PaymentPointVirtualAccountResponse | null>(null);
  const [virtualAccountError, setVirtualAccountError] = useState<string | null>(null);
  const [paymentStartedAt, setPaymentStartedAt] = useState<string | null>(null);
  const [ngnRate, setNgnRate] = useState<number>(1500);
  const [isLoadingRate, setIsLoadingRate] = useState(true);
  const [isFallbackRate, setIsFallbackRate] = useState(false);
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null);
  const paymentPointCheckoutUrl = resolvePaymentPointCheckoutUrl();
  const paymentPointAccountName = resolvePaymentPointAccountName();
  const paymentPointAccountNumber = resolvePaymentPointAccountNumber();
  const paymentPointBankName = resolvePaymentPointBankName();
  const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
  const bankAccounts = virtualAccountData?.bankAccounts || [];

  const hasConfiguredFallbackAccountDetails = Boolean(
    paymentPointAccountName && paymentPointAccountNumber && paymentPointBankName,
  );
  const hasDynamicBankAccounts = bankAccounts.length > 0;

  useEffect(() => {
    const fetchRate = async () => {
      try {
        const res = await apiFetch('/rate');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (typeof data.rate === 'number') {
          setNgnRate(data.rate);
          setIsFallbackRate(data.live !== true);
          setRateUpdatedAt(data.updatedAt || null);
        }
      } catch (error) {
        console.warn('Failed to fetch exchange rate:', error, 'using fallback');
        setNgnRate(1500);
        setIsFallbackRate(true);
        setRateUpdatedAt(null);
      } finally {
        setIsLoadingRate(false);
      }
    };

    fetchRate();
  }, []);

  const handleSelectPlan = (plan: typeof CREDIT_PLANS[0]) => {
    setSelectedPlan(plan);
  };

  const paymentInstructions = useMemo(() => {
    if (!selectedPlan || !user?.email) {
      return '';
    }

    return buildPaymentInstructions({
      plan: selectedPlan,
      email: user.email,
      phoneNumber: normalizedPhoneNumber,
      bankAccounts,
      checkoutUrl: paymentPointCheckoutUrl,
      accountName: paymentPointAccountName,
      accountNumber: paymentPointAccountNumber,
      bankName: paymentPointBankName,
    });
  }, [
    paymentPointAccountName,
    paymentPointAccountNumber,
    paymentPointBankName,
    bankAccounts,
    normalizedPhoneNumber,
    paymentPointCheckoutUrl,
    selectedPlan,
    user?.email,
  ]);

  const copyPaymentInstructions = async () => {
    if (!paymentInstructions) {
      toast.error('Select a plan first to copy PaymentPoint instructions.');
      return;
    }

    try {
      await navigator.clipboard.writeText(paymentInstructions);
      toast.success('PaymentPoint instructions copied.');
    } catch (error) {
      console.error(error);
      toast.error('Unable to copy payment instructions.');
    }
  };

  const handleProceedToPayment = async () => {
    if (!selectedPlan) return;

    if (!user) {
      toast.error('Please log in to purchase credits.');
      navigate('/login');
      return;
    }

    if (!user.email) {
      toast.error('Your account is missing an email address.');
      return;
    }

    if (!normalizedPhoneNumber || normalizedPhoneNumber.length < 10) {
      toast.error('Enter a valid phone number to generate your PaymentPoint account.');
      return;
    }

    if (hasDynamicBankAccounts) {
      if (paymentInstructions) {
        try {
          await navigator.clipboard.writeText(paymentInstructions);
        } catch {
          // Ignore clipboard issues and still reuse the current account.
        }
      }

      toast.success('Reusing the existing virtual account for this customer.');
      toast.info('This app currently reuses the same reserved account for the same email address.');
      return;
    }

    setIsProcessing(true);
    setVirtualAccountError(null);

    try {
      const response = await apiFetch('/create-virtual-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          name: user.name || user.email.split('@')[0] || 'Surevideotool User',
          phoneNumber: normalizedPhoneNumber,
          credits: selectedPlan.credits,
          amountNGN: selectedPlan.priceNGN,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.status !== 'success' || !Array.isArray(data?.bankAccounts) || data.bankAccounts.length === 0) {
        throw new Error(data?.message || `PaymentPoint returned HTTP ${response.status}`);
      }

      setVirtualAccountData(data);
      setPaymentStartedAt(new Date().toISOString());

      const nextInstructions = buildPaymentInstructions({
        plan: selectedPlan,
        email: user.email,
        phoneNumber: normalizedPhoneNumber,
        bankAccounts: data.bankAccounts,
        checkoutUrl: paymentPointCheckoutUrl,
        accountName: paymentPointAccountName,
        accountNumber: paymentPointAccountNumber,
        bankName: paymentPointBankName,
      });

      if (nextInstructions) {
        try {
          await navigator.clipboard.writeText(nextInstructions);
          toast.success('Virtual account ready. Payment instructions copied.');
        } catch {
          toast.success('Virtual account ready.');
        }
      } else {
        toast.success('Virtual account ready.');
      }

      if (paymentPointCheckoutUrl) {
        toast.info('A PaymentPoint checkout link is also available below if you still need it.');
      }

      toast.info('Transfer the exact amount into the reserved account. Credits will be added automatically after webhook confirmation.');
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Failed to create PaymentPoint virtual account';
      setVirtualAccountData(null);
      setVirtualAccountError(message);
      toast.error(message);
    }

    setIsProcessing(false);
  };

  const handleVerifyTransferredPayment = async () => {
    if (!selectedPlan) {
      toast.error('Select a plan first.');
      return;
    }

    if (!user?.id || !user.email) {
      toast.error('Please log in before verifying a transfer.');
      return;
    }

    if (!hasDynamicBankAccounts) {
      toast.error('Generate a PaymentPoint virtual account first.');
      return;
    }

    setIsCheckingPayment(true);
    setVirtualAccountError(null);

    try {
      const response = await apiFetch('/verify-payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: user.id,
          customerEmail: user.email,
          customerId: virtualAccountData?.customer?.customer_id,
          receiverAccountNumber: bankAccounts[0]?.accountNumber,
          amountNGN: selectedPlan.priceNGN,
          credits: selectedPlan.credits,
          createdAfter: paymentStartedAt,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 202 || data?.status === 'pending') {
        toast.info(data?.message || 'Payment is still pending confirmation. Please try again shortly.');
        return;
      }

      if (!response.ok || data?.status !== 'success') {
        throw new Error(data?.message || `PaymentPoint returned HTTP ${response.status}`);
      }

      const creditsAdded = Number(data?.creditsAdded || 0);
      if (creditsAdded > 0) {
        toast.success(`Payment verified. ${creditsAdded.toLocaleString()} credits added.`);
      } else {
        toast.success(data?.message || 'Payment already processed.');
      }

      if (Number.isFinite(Number(data?.newCredits))) {
        toast.info(`Wallet balance: ${Number(data.newCredits).toLocaleString()} credits.`);
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unable to verify your transfer right now';
      setVirtualAccountError(message);
      toast.error(message);
    } finally {
      setIsCheckingPayment(false);
    }
  };

  const getPriceUSD = (priceNGN: number) => (priceNGN / ngnRate).toFixed(2);
  const hasLiveRate = !isLoadingRate && !isFallbackRate;

  return (
    <div className="min-h-screen bg-[#0f0f10] p-6 lg:p-12 flex flex-col items-center">
      <div className="w-full max-w-[800px] pb-32">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-8 text-[#a1a1aa] hover:text-white"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="mb-12">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Credits</h1>
          <p className="text-sm text-[#a1a1aa]">Select credits to power your AI transformations</p>
        </div>

        <div className="mb-6 rounded-2xl border border-[#27272a] bg-[#131316] p-5 shadow-xl shadow-black/20">
          <p className="text-sm text-white font-semibold mb-2">Need the latest version?</p>
          <p className="text-sm text-[#a1a1aa] mb-4">
            Click Recharge from the wallet page to go to Settings, then use the "Check for New Version" button to download and install updates immediately.
          </p>
          <Button
            onClick={() => navigate('/settings')}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Go to Settings
          </Button>
        </div>

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Credits</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {CREDIT_PLANS.map((plan) => {
              const isSelected = selectedPlan?.credits === plan.credits;
              const priceUSD = hasLiveRate ? getPriceUSD(plan.priceNGN) : null;

              return (
                <button
                  key={plan.credits}
                  onClick={() => handleSelectPlan(plan)}
                  className={`p-5 rounded-xl border text-left transition-all duration-200 ${
                    isSelected
                      ? 'bg-gradient-to-br from-blue-600/15 via-blue-600/5 to-transparent border-blue-500 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/50'
                      : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isSelected ? 'bg-blue-500/20' : 'bg-[#27272a]'
                      }`}
                    >
                      <Coins className={`w-5 h-5 ${isSelected ? 'text-blue-400' : 'text-[#71717a]'}`} />
                    </div>
                    <div>
                      <span className="text-lg font-bold text-white">{plan.credits.toLocaleString()} Credits</span>
                      <span className="text-xs text-[#71717a] ml-2">{formatTime(plan.credits)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-bold text-white">₦{plan.priceNGN.toLocaleString()}</span>
                    {priceUSD !== null && (
                      <span className="text-sm text-[#71717a]">(${priceUSD})</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">How credits work</h3>
          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- 2 credits are deducted per second of stream time</li>
            <li>- 500 credits is about 4 minutes 10 seconds</li>
            <li>- 1000 credits is about 8 minutes 20 seconds</li>
            <li>- Credits never expire</li>
          </ul>
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">PaymentPoint flow</h3>
          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- Enter the phone number PaymentPoint should attach to your reserved bank account</li>
            <li>- Generate the virtual account, then transfer the exact amount for the selected plan</li>
            <li>- After transfer, click the manual verification button below to recheck your payment</li>
            <li>- Credits are added once PaymentPoint sends or has already sent a successful webhook notification</li>
          </ul>

          {user?.email && (
            <p className="text-xs text-blue-300 mt-4">
              Payment email for this session: {user.email}
            </p>
          )}

          <div className="mt-4 space-y-2">
            <label htmlFor="paymentpoint-phone" className="block text-xs uppercase tracking-[0.18em] text-[#71717a]">
              PaymentPoint Phone Number
            </label>
            <Input
              id="paymentpoint-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="08012345678"
              value={phoneNumber}
              onChange={(event) => {
                setPhoneNumber(event.target.value);
                setVirtualAccountData(null);
                setVirtualAccountError(null);
                setPaymentStartedAt(null);
              }}
              className="h-11 border-[#27272a] bg-[#0f0f10] text-white placeholder:text-[#52525b]"
            />
            <p className="text-xs text-[#71717a]">
              PaymentPoint requires a customer phone number before it can reserve a virtual account.
            </p>
          </div>

          {hasDynamicBankAccounts && (
            <div className="mt-4 rounded-xl border border-[#27272a] bg-[#0f0f10] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[#71717a] mb-3">Reserved PaymentPoint account</p>
              <div className="space-y-3">
                {bankAccounts.map((bankAccount) => (
                  <div
                    key={`${bankAccount.bankCode || bankAccount.bankName || 'bank'}-${bankAccount.accountNumber || bankAccount.Reserved_Account_Id || 'account'}`}
                    className="rounded-lg border border-[#27272a] bg-[#131316] p-4"
                  >
                    <p className="text-sm font-semibold text-white">{bankAccount.accountName || 'PaymentPoint Account'}</p>
                    <p className="text-lg font-bold text-white tracking-[0.08em] mt-1">{bankAccount.accountNumber || '-'}</p>
                    <p className="text-sm text-[#a1a1aa] mt-1">{bankAccount.bankName || 'PaymentPoint Partner Bank'}</p>
                  </div>
                ))}
              </div>
              {virtualAccountData?.message && (
                <p className="text-xs text-emerald-300 mt-3">{virtualAccountData.message}</p>
              )}
            </div>
          )}

          {!hasDynamicBankAccounts && hasConfiguredFallbackAccountDetails && (
            <div className="mt-4 rounded-xl border border-[#27272a] bg-[#0f0f10] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[#71717a] mb-2">Fallback PaymentPoint account</p>
              <p className="text-sm text-white">{paymentPointAccountName}</p>
              <p className="text-sm text-white">{paymentPointAccountNumber}</p>
              <p className="text-sm text-[#a1a1aa]">{paymentPointBankName}</p>
            </div>
          )}

          {virtualAccountError && (
            <p className="text-sm text-red-400 mt-4">{virtualAccountError}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={copyPaymentInstructions}
              disabled={!selectedPlan || !user?.email}
              className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy Instructions
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={handleVerifyTransferredPayment}
              disabled={!hasDynamicBankAccounts || isCheckingPayment}
              className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
            >
              {isCheckingPayment ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              I've Made Transfer
            </Button>

            {paymentPointCheckoutUrl && (
              <Button
                type="button"
                variant="outline"
                onClick={() => window.open(paymentPointCheckoutUrl, '_blank', 'noopener,noreferrer')}
                className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open Checkout
              </Button>
            )}
          </div>
        </div>

        <div className="text-center">
          <p className="text-sm text-[#71717a] mb-4">All purchases are one-time. No subscriptions or hidden fees.</p>
          {hasLiveRate && (
            <p className="text-xs text-[#52525b]">
              Exchange rate: 1 USD = NGN {ngnRate.toLocaleString()}
            </p>
          )}
          {isLoadingRate && (
            <p className="text-xs text-[#52525b]">
              Loading pricing...
            </p>
          )}
          {isFallbackRate && (
            <p className="text-xs text-amber-400 mt-2">
              Showing fallback pricing. Configure `EXCHANGE_RATE_API_KEY` in the active API environment for live USD to NGN rates.
            </p>
          )}
          {!normalizedPhoneNumber && user && (
            <p className="text-xs text-[#71717a] mt-2">
              Enter a phone number to generate your reserved PaymentPoint account.
            </p>
          )}
          {!isFallbackRate && rateUpdatedAt && (
            <p className="text-xs text-[#52525b] mt-2">
              Last updated: {new Date(rateUpdatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 flex justify-between items-center z-50 animate-in slide-in-from-bottom shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Plan</span>
              <span className="text-xl font-bold text-white tracking-tight">
                {selectedPlan.credits.toLocaleString()} Credits <span className="text-blue-500 font-normal mx-1">/</span> ₦{selectedPlan.priceNGN.toLocaleString()}
                {hasLiveRate && (
                  <>
                    {' '}
                    <span className="text-[#71717a] font-normal">
                      (${getPriceUSD(selectedPlan.priceNGN)})
                    </span>
                  </>
                )}
              </span>
              <span className="text-xs text-[#71717a] mt-1">{formatTime(selectedPlan.credits)} estimated time</span>
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={handleVerifyTransferredPayment}
                disabled={!hasDynamicBankAccounts || isCheckingPayment}
                className="h-12 px-6 border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
              >
                {isCheckingPayment ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                I've Made Transfer
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={copyPaymentInstructions}
                disabled={!paymentInstructions}
                className="h-12 px-6 border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy Details
              </Button>
              <Button
                onClick={handleProceedToPayment}
                disabled={isProcessing || !normalizedPhoneNumber}
                className="h-12 px-8 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:scale-105 transition-all"
              >
                {isProcessing ? (
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                ) : hasDynamicBankAccounts ? (
                  'Use Existing Account'
                ) : (
                  'Generate Virtual Account'
                )}
                {!isProcessing && <ArrowRight className="w-5 h-5 ml-2" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
