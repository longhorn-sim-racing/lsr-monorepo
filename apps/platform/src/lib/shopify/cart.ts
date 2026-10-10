import { shopifyFetch } from './client';
import {
  CART_CREATE_MUTATION,
  CART_LINES_ADD_MUTATION,
  CART_LINES_REMOVE_MUTATION,
  CART_LINES_UPDATE_MUTATION,
  CART_QUERY,
} from './queries';
import { mapCart, type RawCart } from './mappers';
import { Cart } from './types';

export async function createCart(): Promise<Cart> {
  const res = await shopifyFetch<{ cartCreate: { cart: Pick<RawCart, 'id' | 'checkoutUrl'> } }>({
    query: CART_CREATE_MUTATION,
    cache: 'no-store',
  });

  // The create mutation doesn't return the full cart details we want (lines, etc.), 
  // but it returns an ID. We should probably fetch the cart immediately or just return the basic info.
  // Actually, for a fresh cart, lines are empty. We can construct a basic object or fetch.
  // Let's just return what we have, but to map it to our full Cart type, we need fetching.
  // However, optimization: we know it's empty.
  
  const cart = res.body.cartCreate.cart;
  return {
      id: cart.id,
      checkoutUrl: cart.checkoutUrl,
      totalQuantity: 0,
      lines: [],
      cost: {
          subtotalAmount: { amount: '0.0', currencyCode: 'USD' },
          totalAmount: { amount: '0.0', currencyCode: 'USD' },
          totalTaxAmount: { amount: '0.0', currencyCode: 'USD' },
          totalDutyAmount: { amount: '0.0', currencyCode: 'USD' }
      }
  };
}

export async function getCart(cartId: string): Promise<Cart | null> {
  const res = await shopifyFetch<{ cart: RawCart | null }>({
    query: CART_QUERY,
    variables: { cartId },
    cache: 'no-store',
  });

  if (!res.body.cart) {
    return null;
  }

  return mapCart(res.body.cart);
}

export async function addLines(
  cartId: string,
  lines: { merchandiseId: string; quantity: number }[]
): Promise<Cart> {
  await shopifyFetch<unknown>({
    query: CART_LINES_ADD_MUTATION,
    variables: {
      cartId,
      lines: lines.map((line) => ({
        merchandiseId: line.merchandiseId,
        quantity: line.quantity,
      })),
    },
    cache: 'no-store',
  });
  
  // We need to fetch the full cart again to get updated totals and line details? 
  // The mutation returns `cart { id, checkoutUrl, totalQuantity }` usually (depending on query).
  // In `queries.ts` I defined it to return that minimal info. 
  // To get the full updated cart UI, we should fetch the cart again.
  // Or update the mutation to return everything.
  // The prompt constraint: "Use Storefront Cart API ... and redirect to cart.checkoutUrl".
  // Let's just fetch the full cart again to be safe and consistent.
  
  return getCart(cartId) as Promise<Cart>; 
}

export async function updateLines(
  cartId: string,
  lines: { id: string; quantity: number }[]
): Promise<Cart> {
  await shopifyFetch<unknown>({
    query: CART_LINES_UPDATE_MUTATION,
    variables: {
      cartId,
      lines: lines.map((line) => ({
        id: line.id,
        quantity: line.quantity,
      })),
    },
    cache: 'no-store',
  });

  return getCart(cartId) as Promise<Cart>;
}

export async function removeLines(cartId: string, lineIds: string[]): Promise<Cart> {
  await shopifyFetch<unknown>({
    query: CART_LINES_REMOVE_MUTATION,
    variables: {
      cartId,
      lineIds,
    },
    cache: 'no-store',
  });

  return getCart(cartId) as Promise<Cart>;
}
