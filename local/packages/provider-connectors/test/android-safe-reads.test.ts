import { describe, expect, it } from 'vitest';
import { parseRecentOrders, parseSavedAddresses } from '../src/blinkit/android-safe-reads.js';

describe('Blinkit Android safe reads', () => {
  it('returns only saved labels and opaque references from the address picker', () => {
    const source = [
      '<hierarchy>',
      '<node text="Your saved addresses"/>',
      '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/>',
      '<node resource-id="com.grofers.customerapp:id/full_address" text="42 Private Street, Bengaluru 560035"/>',
      '<node resource-id="com.grofers.customerapp:id/address_label" content-desc="AO house"/>',
      '<node resource-id="com.grofers.customerapp:id/address_details" text="Secret locality, Bengaluru"/>',
      '<node resource-id="com.grofers.customerapp:id/location_title" text="Office"/>',
      '<node resource-id="com.grofers.customerapp:id/location_subtitle" text="Another Private Street, Bengaluru 560035"/>',
      '</hierarchy>',
    ].join('');

    const result = parseSavedAddresses(source);

    expect(result).toEqual([
      { addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'Home' },
      { addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'AO house' },
      { addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'Office' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/42 Private|Another Private|560035|Secret locality|full_address|resource-id/i);
  });

  it('returns complete recent-order summaries without delivery-address text', () => {
    const source = [
      '<hierarchy>',
      '<node text="My orders"/>',
      '<node content-desc="Order #BLK123456"/>',
      '<node text="Delivered"/>',
      '<node text="Ordered on 2026-07-22T15:30:00.000Z"/>',
      '<node content-desc="Brown Bread x 1"/>',
      '<node text="Lay&apos;s Magic Masala · Qty 2"/>',
      '<node text="Total ₹115"/>',
      '<node text="Delivered to 42 Private Street, Bengaluru 560035"/>',
      '</hierarchy>',
    ].join('');

    const result = parseRecentOrders(source, 5);

    expect(result).toEqual([{
      orderReference: 'BLK123456',
      items: [{ name: 'Brown Bread', quantity: 1 }, { name: "Lay's Magic Masala", quantity: 2 }],
      total: { currency: 'INR', amount: 115 },
      orderedAt: '2026-07-22T15:30:00.000Z',
      providerStatus: 'delivered',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/42 Private|560035|deliveryAddress|screenshot|xml/i);
  });

  it('omits incomplete order cards rather than inventing facts', () => {
    expect(parseRecentOrders('<hierarchy><node text="Order #BLK123456"/><node text="Delivered"/></hierarchy>', 5)).toEqual([]);
  });

  it('reads current order-history cards without inventing missing quantities or provider IDs', () => {
    const source = [
      '<hierarchy>',
      '<node text="Order History"/>',
      '<node text="Search your grocery orders"/>',
      '<node text="Arrived in 10 minutes"/>',
      '<node text="₹187"/>',
      '<node text="22 Jul, 11:01 pm"/>',
      '<node content-desc="More options"/>',
      '<node text="Hocco Bix Chocolate Chips Ice Cream Sandwich"/>',
      '<node text="Lay&apos;s India&apos;s Magic Masala Potato Chips"/>',
      '<node text="Reorder"/>',
      '<node text="Rate order"/>',
      '<node text="Delivered to 42 Private Street, Bengaluru 560035"/>',
      '</hierarchy>',
    ].join('');

    const result = parseRecentOrders(source, 5, new Date('2026-07-23T00:00:00.000Z'));

    expect(result).toEqual([{
      orderReference: expect.stringMatching(/^order_[a-f0-9]{32}$/),
      items: [
        { name: 'Hocco Bix Chocolate Chips Ice Cream Sandwich' },
        { name: "Lay's India's Magic Masala Potato Chips" },
      ],
      total: { currency: 'INR', amount: 187 },
      orderedAt: '2026-07-22T17:31:00.000Z',
      providerStatus: 'delivered',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/42 Private|560035|deliveryAddress|screenshot|xml/i);
  });
});
