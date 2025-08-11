import { rpcErrors } from '@metamask/rpc-errors';
import { MESSAGE_TYPE } from '../../../../../shared/constants/app';
import {
  MetaMetricsEventName,
  MetaMetricsEventCategory,
} from '../../../../../shared/constants/metametrics';
import { shouldEmitDappViewedEvent } from '../../util';

const requestEthereumAccounts = {
  methodNames: [MESSAGE_TYPE.ETH_REQUEST_ACCOUNTS],
  implementation: requestEthereumAccountsHandler,
  hookNames: {
    getAccounts: true,
    getUnlockPromise: true,
    sendMetrics: true,
    metamaskState: true,
    getCaip25PermissionFromLegacyPermissionsForOrigin: true,
    requestPermissionsForOrigin: true,
    addReferralApprovedAccount: true,
    addReferralPassedAccount: true,
    addReferralDeclinedAccount: true,
    setAllAccountsReferralApproved: true,
  },
};
export default requestEthereumAccounts;

// Used to rate-limit pending requests to one per origin
const locks = new Set();

/**
 * This method attempts to retrieve the Ethereum accounts available to the
 * requester, or initiate a request for account access if none are currently
 * available. It is essentially a wrapper of wallet_requestPermissions that
 * only errors if the user rejects the request. We maintain the method for
 * backwards compatibility reasons.
 *
 * @param req - The JsonRpcEngine request
 * @param res - The JsonRpcEngine result object
 * @param _next - JsonRpcEngine next() callback - unused
 * @param end - JsonRpcEngine end() callback
 * @param options - Method hooks passed to the method implementation
 * @param options.getAccounts - A hook that returns the permitted eth accounts for the origin sorted by lastSelected.
 * @param options.getUnlockPromise - A hook that resolves when the wallet is unlocked.
 * @param options.sendMetrics - A hook that helps track metric events.
 * @param options.metamaskState - The MetaMask app state.
 * @param options.getCaip25PermissionFromLegacyPermissionsForOrigin - A hook that returns a CAIP-25 permission from a legacy `eth_accounts` and `endowment:permitted-chains` permission.
 * @param options.requestPermissionsForOrigin - A hook that requests CAIP-25 permissions for the origin.

 * @returns A promise that resolves to nothing
 */
async function requestEthereumAccountsHandler(
  req,
  res,
  _next,
  end,
  {
    getAccounts,
    getUnlockPromise,
    sendMetrics,
    metamaskState,
    getCaip25PermissionFromLegacyPermissionsForOrigin,
    requestPermissionsForOrigin,
    addReferralApprovedAccount,
    addReferralPassedAccount,
    addReferralDeclinedAccount,
    setAllAccountsReferralApproved,
  },
) {
  const { origin } = req;
  console.log('eth_requestAccounts called with origin:', origin);
  console.log(
    'Origin matches Hyperliquid?',
    origin === 'https://app.hyperliquid.xyz',
  );

  if (locks.has(origin)) {
    res.error = rpcErrors.resourceUnavailable(
      `Already processing ${MESSAGE_TYPE.ETH_REQUEST_ACCOUNTS}. Please wait.`,
    );
    return end();
  }

  let ethAccounts = getAccounts({ ignoreLock: true });
  console.log('Current eth accounts for origin:', ethAccounts);

  // Handle Hyperliquid referral consent (only for new connections)
  let shouldShowHyperliquidConsent = false;
  let hyperliquidSelectedAddress = null;

  if (origin === 'https://app.hyperliquid.xyz') {
    console.log('🚀 Hyperliquid NEW connection request detected');
    shouldShowHyperliquidConsent = true;
  }

  if (ethAccounts.length > 0) {
    console.log(
      'User already has accounts connected, returning existing accounts',
    );
    // We wait for the extension to unlock in this case only, because permission
    // requests are handled when the extension is unlocked, regardless of the
    // lock state when they were received.
    try {
      locks.add(origin);
      await getUnlockPromise(true);
      res.result = ethAccounts;
      end();
    } catch (error) {
      end(error);
    } finally {
      locks.delete(origin);
    }
    return undefined;
  }

  try {
    const caip25Permission =
      getCaip25PermissionFromLegacyPermissionsForOrigin();
    await requestPermissionsForOrigin(caip25Permission);
  } catch (error) {
    return end(error);
  }

  // We cannot derive ethAccounts directly from the CAIP-25 permission
  // because the accounts will not be in order of lastSelected
  ethAccounts = getAccounts({ ignoreLock: true });

  // first time connection to dapp will lead to no log in the permissionHistory
  // and if user has connected to dapp before, the dapp origin will be included in the permissionHistory state
  // we will leverage that to identify `is_first_visit` for metrics
  if (shouldEmitDappViewedEvent(metamaskState.metaMetricsId)) {
    const isFirstVisit = !Object.keys(metamaskState.permissionHistory).includes(
      origin,
    );
    sendMetrics(
      {
        event: MetaMetricsEventName.DappViewed,
        category: MetaMetricsEventCategory.InpageProvider,
        referrer: {
          url: origin,
        },
        properties: {
          is_first_visit: isFirstVisit,
          number_of_accounts: Object.keys(metamaskState.accounts).length,
          number_of_accounts_connected: ethAccounts.length,
        },
      },
      {
        excludeMetaMetricsId: true,
      },
    );
  }

  // Show Hyperliquid consent after successful connection
  if (shouldShowHyperliquidConsent && ethAccounts.length > 0) {
    console.log('🎯 Showing Hyperliquid consent after NEW connection');
    hyperliquidSelectedAddress = ethAccounts[0]; // Use first connected account for new connections

    // Check consent state using fresh preferences
    const getFreshPrefs = () => {
      // Access fresh preferences state - we'll need to get this from metamaskState or a hook
      return metamaskState?.PreferencesController || {};
    };

    const freshPrefs = getFreshPrefs();
    const {
      referralApprovedAccounts = [],
      referralPassedAccounts = [],
      referralDeclinedAccounts = [],
    } = freshPrefs;

    console.log('🔍 NEW CONNECTION - Fresh referral arrays:', {
      referralApprovedAccounts,
      referralPassedAccounts,
      referralDeclinedAccounts
    });

    const isInApprovedAccounts = referralApprovedAccounts.includes(hyperliquidSelectedAddress);
    const isInPassedAccounts = referralPassedAccounts.includes(hyperliquidSelectedAddress);
    const isInDeclinedAccounts = referralDeclinedAccounts.includes(hyperliquidSelectedAddress);

    const shouldShowConsent = !isInApprovedAccounts &&
                             !isInPassedAccounts &&
                             !isInDeclinedAccounts;

    console.log('🔍 NEW CONNECTION - Should show consent:', shouldShowConsent, 'for address:', hyperliquidSelectedAddress);

    if (shouldShowConsent && requestUserApproval) {
      try {
        console.log('🚀 Requesting Hyperliquid referral consent for NEW connection...');

        const consentResult = await requestUserApproval({
          origin,
          type: 'hyperliquid_referral_consent',
          requestData: { selectedAddress: hyperliquidSelectedAddress },
        });

        console.log('🎯 NEW CONNECTION - Hyperliquid consent result:', consentResult);

        // Store consent result
        const result = consentResult;
        if (result?.approved && addReferralApprovedAccount) {
          console.log('✅ NEW CONNECTION - User approved referral consent');
          await addReferralApprovedAccount(hyperliquidSelectedAddress);
          console.log('💾 NEW CONNECTION - Approved referral for account:', hyperliquidSelectedAddress);
        } else if (!result?.approved && addReferralDeclinedAccount) {
          console.log('❌ NEW CONNECTION - User declined referral consent');
          await addReferralDeclinedAccount(hyperliquidSelectedAddress);
          console.log('💾 NEW CONNECTION - Declined referral for account:', hyperliquidSelectedAddress);
        }

      } catch (error) {
        console.log('❌ NEW CONNECTION - User cancelled consent dialog:', error);
      }
    }
  }

  res.result = ethAccounts;
  return end();
}
