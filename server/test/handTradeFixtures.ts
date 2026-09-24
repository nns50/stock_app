// ---------------------------------------------------------------------------
// Two trades the app did not open, as Webull reported them (2026-09-24).
//
// Read through the deployed app's read-only probes. The shapes and values are
// the broker's own; only the ids are replaced (a position id, and each order's
// client_order_id: 24 hex characters for an order placed in Webull's own app,
// 32 for one of this app's).
//
// 1. The operator's 1-share AMC test short, the first stock short this account
//    ever held (task #126). Webull reports a short position as a NEGATIVE
//    quantity string with no side field; `cost_price` stays positive while
//    `cost` and `market_value` go negative. The entry order's side is SHORT
//    (not SELL). The cover was a BUY one-cancels-other: the take-profit leg
//    (combo_type STOP_PROFIT, a limit) filled at 2.82 and cancelled the stop.
// 2. The options sleeve's DELL call of 2026-09-23. The sleeve keeps its own
//    table, so the position sync imported the contract into the journal too,
//    and closed that copy at a $9.90 quote. The sleeve's own stop filled at
//    $4.95. The copy's times are the 09-23 database's; the close's envelope is
//    rebuilt from the sleeve's journal rows (the exit placed at 09:47:50 ET,
//    the copy closed at 09:49:01), in the shape the history returns for a
//    single-leg option (parseBrokerOptionFills' NVDA fixture).
// ---------------------------------------------------------------------------

/** GET positions, the AMC row, at 09:47:31 ET on 2026-09-24. */
export const AMC_SHORT_POSITION_ROW = {
  currency: 'USD',
  quantity: '-1',
  cost: '-2.83',
  proportion: '0.0019',
  position_id: 'POSITION-AMC',
  symbol: 'AMC',
  instrument_type: 'EQUITY',
  cost_price: '2.83',
  last_price: '2.83',
  market_value: '-2.83',
  unrealized_profit_loss: '0.00',
  unrealized_profit_loss_rate: '0.0000',
  day_profit_loss: '-0.02',
  day_realized_profit_loss: '-0.02',
};

export const AMC_SHORT_ENTRY_ID = '6ad3f0a1c2b3d4e5f6a7b801';
export const AMC_COVER_ID = '6ad3f0a1c2b3d4e5f6a7b802';
export const AMC_COVER_STOP_ID = '6ad3f0a1c2b3d4e5f6a7b803';

/** The order history's three AMC envelopes. */
export const AMC_SHORT_ENTRY_ENVELOPE = {
  client_order_id: AMC_SHORT_ENTRY_ID,
  combo_type: 'NORMAL',
  combo_order_id: 'COMBO-AMC-ENTRY',
  orders: [
    {
      client_order_id: AMC_SHORT_ENTRY_ID,
      symbol: 'AMC',
      side: 'SHORT',
      status: 'FILLED',
      instrument_type: 'EQUITY',
      order_type: 'LIMIT',
      time_in_force: 'DAY',
      total_quantity: '1',
      filled_quantity: '1',
      limit_price: '2.83',
      filled_price: '2.83',
      place_time: '1790257522395',
      place_time_at: '2026-09-24T13:45:22.395Z',
      filled_time: '1790257530583',
      filled_time_at: '2026-09-24T13:45:30.583Z',
    },
  ],
};
export const AMC_COVER_ENVELOPE = {
  client_order_id: AMC_COVER_ID,
  combo_type: 'STOP_PROFIT',
  combo_order_id: 'COMBO-AMC-OCO',
  orders: [
    {
      client_order_id: AMC_COVER_ID,
      symbol: 'AMC',
      side: 'BUY',
      status: 'FILLED',
      instrument_type: 'EQUITY',
      order_type: 'LIMIT',
      time_in_force: 'DAY',
      total_quantity: '1',
      filled_quantity: '1',
      limit_price: '2.83',
      filled_price: '2.82',
      place_time: '1790257679084',
      place_time_at: '2026-09-24T13:47:59.084Z',
      filled_time: '1790257973566',
      filled_time_at: '2026-09-24T13:52:53.566Z',
    },
  ],
};
export const AMC_COVER_STOP_ENVELOPE = {
  client_order_id: AMC_COVER_STOP_ID,
  combo_type: 'STOP_LOSS',
  combo_order_id: 'COMBO-AMC-OCO',
  orders: [
    {
      client_order_id: AMC_COVER_STOP_ID,
      symbol: 'AMC',
      side: 'BUY',
      status: 'CANCELLED',
      instrument_type: 'EQUITY',
      order_type: 'STOP_LOSS',
      time_in_force: 'DAY',
      total_quantity: '1',
      filled_quantity: '0',
      stop_price: '2.83',
      place_time: '1790257679084',
      place_time_at: '2026-09-24T13:47:59.084Z',
    },
  ],
};

/** 2026-09-24, ET: the short filled 09:45:30; the sync had imported it by
 *  the 09:47:31 probe; the cover filled 09:52:53; the sync booked the close
 *  at a $2.805 quote 21 seconds later. */
export const AMC_TIMES = {
  imported: Date.parse('2026-09-24T13:46:30.000Z'),
  coverFilled: Date.parse('2026-09-24T13:52:53.566Z'),
  estimateBooked: Date.parse('2026-09-24T13:53:14.000Z'),
  estimatePrice: 2.805,
};

export const DELL_SLEEVE_CLOSE_ID = '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f';

/** The sleeve's stop on its DELL 575 call (2026-09-25 expiry): a limit at the
 *  4.90 bid, filled at 4.95. */
export const DELL_SLEEVE_CLOSE_ENVELOPE = {
  client_order_id: DELL_SLEEVE_CLOSE_ID,
  combo_type: 'NORMAL',
  combo_order_id: 'COMBO-DELL-CLOSE',
  orders: [
    {
      client_order_id: DELL_SLEEVE_CLOSE_ID,
      symbol: 'DELL',
      side: 'SELL',
      status: 'FILLED',
      instrument_type: 'OPTION',
      option_strategy: 'SINGLE',
      position_intent: 'SELL_TO_CLOSE',
      order_type: 'LIMIT',
      total_quantity: '1',
      filled_quantity: '1',
      limit_price: '4.90',
      filled_price: '4.95',
      filled_time: '1790171272000',
      filled_time_at: '2026-09-23T13:47:52.000Z',
      legs: [
        {
          id: 'L1',
          quantity: '1',
          side: 'SELL',
          symbol: 'DELL',
          option_type: 'CALL',
          option_expire_date: '2026-09-25',
          strike_price: '575.00',
        },
      ],
    },
  ],
};

/** The journal's copy (#691 on the 09-23 database): imported 09:38:33 ET,
 *  closed by the sync at 09:49:01 at a $9.90 quote. */
export const DELL_COPY = {
  imported: 1790170713569,
  estimateBooked: 1790171341675,
  estimatePrice: 9.9,
  entryPrice: 6.6,
  strike: 575,
  expiration: '2026-09-25',
};
