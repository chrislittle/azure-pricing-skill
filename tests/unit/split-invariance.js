const { priceSpec } = require('../../scripts/lib/estimate');
(async () => {
  const base = { region: 'centralus', currency: 'USD', discountPct: 0 };
  const one = await priceSpec({ ...base, options: [{ name: 'one', components: [{ type: 'container-apps', apps: 2, vcpu: 0.5, memGiB: 1, requests: 3000000 }] }] });
  const two = await priceSpec({ ...base, options: [{ name: 'two', components: [{ type: 'container-apps', apps: 1, vcpu: 0.5, memGiB: 1, requests: 1500000 }, { type: 'container-apps', apps: 1, vcpu: 0.5, memGiB: 1, requests: 1500000 }] }] });
  const bw1 = await priceSpec({ ...base, options: [{ name: 'a', components: [{ type: 'bandwidth', egressGB: 20480 }] }] });
  const bw2 = await priceSpec({ ...base, options: [{ name: 'b', components: [{ type: 'bandwidth', egressGB: 10240 }, { type: 'bandwidth', egressGB: 10240 }] }] });
  const f1 = await priceSpec({ ...base, options: [{ name: 'f', components: [{ type: 'functions', executions: 5000000, gbSeconds: 500000 }] }] });
  const f2 = await priceSpec({ ...base, options: [{ name: 'g', components: [{ type: 'functions', executions: 2500000, gbSeconds: 250000 }, { type: 'functions', executions: 2500000, gbSeconds: 250000 }] }] });
  const t = (x) => x.options[0].totalList;
  const ok = (a, b, n) => console.log((Math.abs(t(a) - t(b)) <= 0.02 ? 'PASS ' : 'FAIL ') + n, t(a), t(b));
  ok(one, two, 'container apps split'); ok(bw1, bw2, 'egress split'); ok(f1, f2, 'functions split');
})();

