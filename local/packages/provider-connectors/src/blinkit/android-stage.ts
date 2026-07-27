export type BlinkitAndroidStage = 'login_required' | 'otp_requested' | 'storefront' | 'address_picker' | 'checkout' | 'payment_sheet' | 'confirmed' | 'review_prompt' | 'location_permission' | 'unknown';

export function detectBlinkitAndroidStage(source: string): BlinkitAndroidStage {
  const text = source.toLowerCase();
  if (text.includes('location permission not enabled') && text.includes('select location manually')) return 'location_permission';
  if (text.includes('not now') && text.includes('submit')) return 'review_prompt';
  if (text.includes('order is confirmed') || text.includes('track order')) return 'confirmed';
  if (text.includes('cash on delivery') && text.includes('bill total')) return 'payment_sheet';
  if ((text.includes('place order') && (text.includes('pay using') || text.includes('delivering to')))
    || (text.includes('select payment option') && text.includes('delivering to'))
    || (text.includes('shipment of') && text.includes('delivering to'))) return 'checkout';
  if (text.includes('select delivery location') || text.includes('your saved addresses')) return 'address_picker';
  if (text.includes('one time password') || text.includes('verification code')) return 'otp_requested';
  if (text.includes('log in or sign up') || (text.includes("india's last minute app") && text.includes('continue'))) return 'login_required';
  if (text.includes('view cart') || text.includes('search for atta')) return 'storefront';
  return 'unknown';
}
