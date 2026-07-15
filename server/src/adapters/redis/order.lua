-- order.lua — the atomic order decision. THE authoritative implementation:
-- membership check, stock check, SADD, DECR execute as one server-side unit
-- (Redis runs scripts single-threaded — nothing interleaves). While the API
-- serves traffic this script is the ONLY writer of orders:{saleId}:users and
-- stock:{saleId}:remaining. No rollback logic exists.
--
-- KEYS[1] = stock:{saleId}:remaining
-- KEYS[2] = orders:{saleId}:users
-- ARGV[1] = email    (trimmed and NFC-normalised by the route before it gets here)
--
-- Key names are passed via KEYS[] (constructed by the caller from the resolved
-- saleId) so Redis Cluster can hash-slot the command. No key names are
-- hardcoded — every sale gets its own namespace, so multiple sale records can
-- coexist without collision.
--
-- Reply: { verdict, remaining } — verdict is exactly one of OK | ALREADY |
-- SOLD_OUT; remaining is the stock after this call (post-DECR on OK). The
-- caller publishes sale.sold_out exactly once when remaining == 0 on an OK.
--
-- Missing stock key -> error reply (fail closed, 503 at the API edge): never
-- fabricate a number — 0 would lie "sold out". A flushed Redis lost
-- orders:{saleId}:users too, so no honest ALREADY exists in that state either.
-- The cold-start rebuild (bootstrap.ts) makes this state unreachable.
local stockKey = KEYS[1]
local ordersKey = KEYS[2]
local stock = tonumber(redis.call('GET', stockKey))
if stock == nil then
  return redis.error_reply(stockKey .. ' missing')
end
if redis.call('SISMEMBER', ordersKey, ARGV[1]) == 1 then
  return { 'ALREADY', stock }
end
if stock <= 0 then
  return { 'SOLD_OUT', stock }
end
redis.call('SADD', ordersKey, ARGV[1])
return { 'OK', redis.call('DECR', stockKey) }
