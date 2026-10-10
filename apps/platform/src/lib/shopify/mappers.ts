import { Product, Image, Money, ProductVariant, Cart, CartLine } from './types';

// What the Storefront API sends back, before mapping. Fields the queries don't always ask for are optional.
type Connection<T> = { edges: { node: T }[] } | { nodes: T[] };
type SelectedOption = { name: string; value: string };
type RawMoney = { amount?: string; currencyCode?: string } | null | undefined;
type RawImage = { url?: string; altText?: string | null; width?: number; height?: number } | null | undefined;

export type RawVariant = {
  id: string;
  title: string;
  availableForSale: boolean;
  selectedOptions?: SelectedOption[];
  price?: RawMoney;
};

export type RawProduct = {
  id: string;
  handle: string;
  title: string;
  description: string;
  descriptionHtml?: string;
  updatedAt: string;
  images?: Connection<RawImage>;
  variants?: Connection<RawVariant>;
  tags?: string[];
  productType: string;
  availableForSale: boolean;
  priceRange?: { minVariantPrice?: RawMoney; maxVariantPrice?: RawMoney };
};

export type RawCartLine = {
  id: string;
  quantity: number;
  cost?: { totalAmount?: RawMoney };
  merchandise: {
    id: string;
    title: string;
    product: { id: string; handle: string; title: string; featuredImage?: RawImage };
    image?: RawImage;
    selectedOptions?: SelectedOption[];
    price?: RawMoney;
  };
};

export type RawCart = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  lines?: Connection<RawCartLine>;
  cost?: { subtotalAmount?: RawMoney; totalAmount?: RawMoney; totalTaxAmount?: RawMoney; totalDutyAmount?: RawMoney };
};

export const removeEdgesAndNodes = <T>(array: { edges: { node: T }[] } | { nodes: T[] } | undefined): T[] => {
  if (!array) return [];
  if ('edges' in array) {
    return array.edges.map((edge) => edge.node);
  }
  return array.nodes;
};

export const mapImage = (image: RawImage): Image => ({
  url: image?.url || '',
  altText: image?.altText || '',
  width: image?.width || 0,
  height: image?.height || 0,
});

export const mapMoney = (money: RawMoney): Money => ({
  amount: money?.amount || '0.0',
  currencyCode: money?.currencyCode || 'USD',
});

export const mapVariant = (variant: RawVariant): ProductVariant => ({
  id: variant.id,
  title: variant.title,
  availableForSale: variant.availableForSale,
  selectedOptions: variant.selectedOptions || [],
  price: mapMoney(variant.price),
});

export const mapProduct = (product: RawProduct): Product => ({
  id: product.id,
  handle: product.handle,
  title: product.title,
  description: product.description,
  descriptionHtml: product.descriptionHtml,
  updatedAt: product.updatedAt,
  images: removeEdgesAndNodes(product.images).map(mapImage),
  variants: removeEdgesAndNodes(product.variants).map(mapVariant),
  tags: product.tags || [],
  productType: product.productType,
  availableForSale: product.availableForSale,
  priceRange: {
    minVariantPrice: mapMoney(product.priceRange?.minVariantPrice),
    maxVariantPrice: mapMoney(product.priceRange?.maxVariantPrice),
  },
});

export const mapCartLine = (line: RawCartLine): CartLine => ({
  id: line.id,
  quantity: line.quantity,
  cost: {
    totalAmount: mapMoney(line.cost?.totalAmount),
  },
  merchandise: {
    id: line.merchandise.id,
    title: line.merchandise.title,
    product: {
      id: line.merchandise.product.id,
      handle: line.merchandise.product.handle,
      title: line.merchandise.product.title,
      featuredImage: mapImage(line.merchandise.product.featuredImage),
    },
    image: mapImage(line.merchandise.image),
    selectedOptions: line.merchandise.selectedOptions || [],
    price: mapMoney(line.merchandise.price),
  },
});

export const mapCart = (cart: RawCart): Cart => ({
  id: cart.id,
  checkoutUrl: cart.checkoutUrl,
  totalQuantity: cart.totalQuantity,
  lines: removeEdgesAndNodes(cart.lines).map(mapCartLine),
  cost: {
    subtotalAmount: mapMoney(cart.cost?.subtotalAmount),
    totalAmount: mapMoney(cart.cost?.totalAmount),
    totalTaxAmount: mapMoney(cart.cost?.totalTaxAmount),
    totalDutyAmount: mapMoney(cart.cost?.totalDutyAmount),
  },
});
