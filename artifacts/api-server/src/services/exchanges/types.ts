export interface ExchangeTicker {
  exchange: string;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spread: number;
  priceChange24h: number;
  priceChangePct24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime: number;
  updatedAt: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total: number;
}

export interface ExchangeOrderbook {
  exchange: string;
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  spreadPct: number;
  imbalance: number;
  updatedAt: number;
}

export interface ExchangeTrade {
  id: string;
  exchange: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
}

export interface ExchangeBalance {
  total: number;
  available: number;
  currency: string;
}

export interface ExchangePosition {
  exchange: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  qty: number;
  price?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
}

export interface OrderResult {
  orderId: string;
  exchange: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  status: string;
}

export interface IExchangeConnector {
  readonly name: string;
  readonly connected: boolean;

  connect(): void;
  getTicker(): ExchangeTicker | null;
  getOrderbook(): ExchangeOrderbook | null;
  getTrades(): ExchangeTrade[];

  getBalance(): Promise<ExchangeBalance>;
  getPositions(): Promise<ExchangePosition[]>;
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
}
