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
 * Extracts all order blocks from an Amazon email.
 * Handles both single and multiple orders in one email.
 */
export function extractOrderBlocks(emailText: string): string[] {
  const blocks: string[] = [];

  // Find all "Order #" positions
  const orderPattern = /Order #\s*[\u200f]?\s*[\d\-]+/gi;
  const matches = [...emailText.matchAll(orderPattern)];

  if (matches.length === 0) {
    return [];
  }

  // Find the footer position
  const footerMatch = emailText.match(/©\d{4} Amazon/i);
  const footerIndex = footerMatch?.index ?? emailText.length;

  // Extract each order block (from one Order # to the next, or to footer)
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length
      ? (matches[i + 1].index ?? footerIndex)
      : footerIndex;

    const block = emailText.slice(start, end).trim();
    if (block.length > 0) {
      blocks.push(block);
    }
  }

  return blocks;
}

/**
 * Computes the tax amount for each item in an order by proportionally
 * allocating the total tax across all items based on their pre-tax cost.
 * Works with cents (integers) to avoid floating-point precision issues.
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
  const orderBlocks = extractOrderBlocks(emailText);

  if (orderBlocks.length === 0) {
    throw new Error('Failed to extract order blocks from amazon email');
  }

  const actions: (LunchMoneyAction | null)[] = [];

  for (const orderText of orderBlocks) {
    const order = await extractOrder(orderText, env);

    console.log('Got order details from amazon email', {order});

    if (order.totalCostCents === 0) {
      console.info('Ignoring Amazon order with zero cost', {orderId: order.orderId});
      continue;
    }

    actions.push(makeAction(order));
  }

  // Return first non-null action (Worker handles one action per email call)
  return actions.find(a => a !== null) ?? null;
}

function matchEmail(email: Email) {
  const {from, subject} = email;
  return !!(
    from?.address?.endsWith('amazon.com') ||
    from?.address?.endsWith('amazon.ca')
  ) && !!subject?.startsWith('Ordered');
}

export const amazonProcessor: EmailProcessor = {
  identifier: 'amazon',
  matchEmail,
  process,
};