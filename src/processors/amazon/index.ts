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
 * Extracts the order block from an Amazon shipped or refund email.
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

function makeShippedAction(order: AmazonOrder): LunchMoneyAction {
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

function makeRefundAction(order: AmazonOrder): LunchMoneyAction {
  const match: LunchMoneyMatch = {
    expectedPayee: 'Amazon',
    expectedTotal: -order.totalCostCents,
  };

  const note = order.orderItems.length > 0
    ? `Refund: ${makeItemNote(order, order.orderItems[0])}`
    : `Refund (${order.orderId})`;

  const updateAction: LunchMoneyUpdate = {
    match,
    type: 'update',
    note,
  };

  return updateAction;
}

function isRefundEmail(email: Email): boolean {
  return !!(
    email.from?.address === 'return@amazon.ca' ||
    email.from?.address === 'return@amazon.com'
  );
}

async function process(email: Email, env: Env) {
  const emailText = email.text ?? '';
  const orderText = extractOrderBlock(emailText);

  if (orderText === null) {
    throw new Error('Failed to extract order block from amazon email');
  }

  const order = await extractOrder(orderText, env);

  console.log('Got order details from amazon email', {
    order,
    isRefund: isRefundEmail(email),
  });

  if (order.totalCostCents === 0) {
    console.info('Ignoring Amazon order with zero cost', {orderId: order.orderId});
    return null;
  }

  return isRefundEmail(email)
    ? makeRefundAction(order)
    : makeShippedAction(order);
}

function matchEmail(email: Email) {
  const {from, subject} = email;

  const isShipped =
    (from?.address === 'shipment-tracking@amazon.ca' ||
      from?.address === 'shipment-tracking@amazon.com') &&
    !!subject?.startsWith('Shipped:');

  const isRefund =
    (from?.address === 'return@amazon.ca' ||
      from?.address === 'return@amazon.com') &&
    !!subject?.startsWith('Your refund for');

  return isShipped || isRefund;
}

export const amazonProcessor: EmailProcessor = {
  identifier: 'amazon',
  matchEmail,
  process,
};