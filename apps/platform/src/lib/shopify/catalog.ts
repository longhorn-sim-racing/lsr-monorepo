import { shopifyFetch } from './client';
import { PRODUCTS_QUERY, PRODUCT_BY_HANDLE_QUERY } from './queries';
import { mapProduct, removeEdgesAndNodes, type RawProduct } from './mappers';
import { Product } from './types';

export async function getProducts(): Promise<Product[]> {
  const { body } = await shopifyFetch<{ products: { edges: { node: RawProduct }[] } | { nodes: RawProduct[] } }>({
    query: PRODUCTS_QUERY,
    revalidate: 1,
  });

  return removeEdgesAndNodes(body.products).map(mapProduct);
}

export async function getProductByHandle(handle: string): Promise<Product | null> {
  const { body } = await shopifyFetch<{ product: RawProduct | null }>({
    query: PRODUCT_BY_HANDLE_QUERY,
    variables: { handle },
    revalidate: 1,
  });

  if (!body.product) {
    return null;
  }

  return mapProduct(body.product);
}
