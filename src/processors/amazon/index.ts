import {Email} from 'postal-mime';

import {
  EmailProcessor,
  LunchMoneyAction,
  LunchMoneyMatch,
  LunchMoneySplit,
  LunchMoneyUpdate,
} from 'src/types';

import {extractOrder} from './prompt';
import {AmazonOrder, AmazonOrderItem} from './types';

/**
 * Extracts the order block from an Amazon shipped email.
 */
export function extractOrderBlock(emailText: string): string | null {
  const orderStartMatch = emailText.match(/Order #\s*[\u200f]?\s*[\d\-]+/i);
  if (!orderStartMatch || orderStartMatch.index === undefined) {
    return null;
  }

  const orderStartIndex = orderStartMatch.index;
  const footerMatch = emailText.match(/©\d{4} Amazon/i);
  const footerIndex = footerMatch?.index ?? emailText.length;

  return emailText.slice(orderStartIndex, footerIndex).trim();
}

/**
 * Computes the tax amount for each item proportionally.
 */
export function computeItemTaxes(items: AmazonOrderItem[], totalCents: number): number[] {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.priceEachCents * item.quantity,
    0,
  );

  const totalTaxCents = totalCents - subtotalCents;

  if (totalTaxCents < 0) {
    throw new Error('Total cost is less than subtotal.');
  }

  if (totalTaxCents === 0) {
    return items.map(() => 0);
  }

  const taxCents = items.map(item => {
    const itemCostCents = item.priceEachCents * item.quantity;
    return Math.round((itemCostCents / subtotalCents) * totalTaxCents);
  });

  const calculatedTotalTax = taxCents.reduce((sum, tax) => sum + tax, 0);
  const difference = totalTaxCents - calculatedTotalTax;
  taxCents[taxCents.length - 1] += difference;

  return taxCents;
}

function makeItemNote(order: AmazonOrder, item: AmazonOrderItem) {
  return `${item.shortName} (${order.orderId})`;
}

function makeAction(order: AmazonOrder): LunchMoneyAction {
  const itemsTax = computeItemTaxes(order.orderItems, order.totalCostCents);

  const match: LunchMoneyMatch = {
    expectedPayee: 'Amazon',
    expectedTotal: order.totalCostCents,
  };

  if (order.orderItems.length > 1) {
    const splitAction: LunchMoneySplit = {
      match,
      type: 'split',
      split: order.orderItems.map((item, i) => ({
        note: makeItemNote(order, item),
        amount: item.priceEachCents + itemsTax[i],
      })),
    };

    return splitAction;
  }

  const updateAction: LunchMoneyUpdate = {
    match,
    type: 'update',
    note: makeItemNote(order, order.orderItems[0]),
  };

  return updateAction;
}

async function process(email: Email, env: Env) {
  const emailText = email.text ?? '';
  const orderText = extractOrderBlock(emailText);

  if (orderText === null) {
    throw new Error('Failed to extract order block from amazon shipped email');
  }

  const order = await extractOrder(orderText, env);

  console.log('Got order details from amazon shipped email', {order});

  if (order.totalCostCents === 0) {
    console.info('Ignoring Amazon order with zero cost', {orderId: order.orderId});
    return null;
  }

  return makeAction(order);
}

function matchEmail(email: Email) {
  const {from, subject} = email;
  return !!(
    from?.address === 'shipment-tracking@amazon.ca' ||
    from?.address === 'shipment-tracking@amazon.com'
  ) && !!subject?.startsWith('Shipped:');
}

export const amazonProcessor: EmailProcessor = {
  identifier: 'amazon',
  matchEmail,
  process,
};