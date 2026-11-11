/** Public DoneBot-api account settings; no credentials or verification secrets. */
export interface DoneBotAuthSettings {
  registration_enabled?: boolean;
  email_verify_enabled?: boolean;
  password_reset_enabled?: boolean;
  invitation_code_enabled?: boolean;
  promo_code_enabled?: boolean;
  registration_email_suffix_whitelist?: string[];
  login_agreement_enabled?: boolean;
  login_agreement_documents?: { id: string; title: string; content_md: string }[];
  turnstile_enabled?: boolean;
  turnstile_site_key?: string;
  tencent_captcha_enabled?: boolean;
  tencent_captcha_app_id?: string;
  tencent_captcha_region?: string;
  aliyun_captcha_enabled?: boolean;
  aliyun_captcha_scene_id?: string;
  aliyun_captcha_prefix?: string;
  aliyun_captcha_region?: string;
}

/** One-use vendor proof returned by the desktop's isolated challenge window. */
export interface DoneBotAuthProof {
  turnstile_token?: string;
  tencent_captcha_ticket?: string;
  tencent_captcha_randstr?: string;
}

/** DoneBot-api email delivery timing, in seconds. */
export interface DoneBotEmailDelivery { countdown?: number; expires_in?: number }
