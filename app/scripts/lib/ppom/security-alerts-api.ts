import { JsonRpcRequest } from '@metamask/utils';
import { SecurityAlertResponse, ShieldParams } from './types';

const ENDPOINT_VALIDATE = 'validate';

type SecurityAlertsAPIRequestBody = {
  method: string;
  params: unknown[];
};

export type SecurityAlertsAPIRequest = Omit<
  JsonRpcRequest,
  'method' | 'params'
> &
  SecurityAlertsAPIRequestBody;

export function isSecurityAlertsAPIEnabled() {
  const isEnabled = process.env.SECURITY_ALERTS_API_ENABLED;
  return isEnabled?.toString() === 'true';
}

export async function validateWithSecurityAlertsAPI(
  chainId: string,
  body:
    | SecurityAlertsAPIRequestBody
    | Pick<JsonRpcRequest, 'method' | 'params'>,
  shieldParams?: ShieldParams,
): Promise<SecurityAlertResponse> {
  const endpoint = `${ENDPOINT_VALIDATE}/${chainId}`;

  const isShieldEnabled = shieldParams?.isShieldEnabled
    ? await shieldParams.isShieldEnabled()
    : false;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Shield endpoint requires access token.
  if (isShieldEnabled) {
    if (!shieldParams?.getAccessToken) {
      throw new Error(
        'getAccessToken is required when isShieldEnabled is true',
      );
    }
    const accessToken = await shieldParams.getAccessToken();
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return request(
    endpoint,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    },
    isShieldEnabled,
  );
}

async function request(
  endpoint: string,
  options?: RequestInit,
  isShieldEnabled: boolean = false,
) {
  const url = getUrl(endpoint, isShieldEnabled);

  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(
      `Security alerts API request failed with status: ${response.status}`,
    );
  }

  return await response.json();
}

function getUrl(endpoint: string, isShieldEnabled: boolean = false) {
  const host = isShieldEnabled
    ? process.env.SECURITY_ALERTS_API_URL_SHIELD
    : process.env.SECURITY_ALERTS_API_URL;

  if (!host) {
    throw new Error('Security alerts API URL is not set');
  }

  return `${host}/${endpoint}`;
}
