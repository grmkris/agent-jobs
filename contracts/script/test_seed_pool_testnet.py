"""Wrapper preflight tests with disposable config/lock and read-only command test doubles."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).parent


class SeedPoolWrapperTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'script').mkdir()
        (self.root / 'config').mkdir()
        (self.root / 'bin').mkdir()
        for name in ('seed-pool-testnet.sh', 'launch-lock.sh'):
            (self.root / 'script' / name).write_bytes((SCRIPT / name).read_bytes())
        self.record = json.loads((SCRIPT.parent / 'config/monad-testnet.json').read_text())
        self.record['liquidity'].update(factoryAmount=1, quoteAmount=3, maxRepairCost=2)
        self.config = self.root / 'config/monad-testnet.json'
        self.calls = self.root / 'forge-calls.jsonl'
        cast = self.root / 'bin/cast'
        cast.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
c = json.loads(Path('config/monad-testnet.json').read_text())
a = sys.argv[1:]
if a[0] == 'chain-id': print(10143)
elif a[0] == 'wallet': print(c['hireling']['allocation']['liquidity'])
elif a[0] == 'code': print('0x6000')
elif a[0] == 'call':
    method = a[2]
    if method == 'decimals()(uint8)': print(6 if a[1].lower() == c['liquidity']['quote'].lower() else 18)
    elif method == 'poolManager()(address)': print(c['liquidity']['uniswapV4']['poolManager'])
    elif method == 'permit2()(address)': print(c['liquidity']['uniswapV4']['permit2'])
    elif method == 'balanceOf(address)(uint256)':
        print(os.environ['QUOTE_BALANCE' if a[1].lower() == c['liquidity']['quote'].lower() else 'FACTORY_BALANCE'])
    else: raise SystemExit('unexpected read')
else: raise SystemExit('unexpected command; sends forbidden in this test')
''')
        cast.chmod(0o700)
        forge = self.root / 'bin/forge'
        forge.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
with Path('forge-calls.jsonl').open('a') as out:
    out.write(json.dumps(sys.argv[1:]) + '\\n')
''')
        forge.chmod(0o700)

    def run_wrapper(self, factory='1666666666666666666', quote='5000000'):
        self.config.write_text(json.dumps(self.record))
        env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'],
                   MONAD_TESTNET_RPC_URL='http://unused.invalid', DEPLOYER_PRIVATE_KEY='unit-test-not-a-key',
                   FACTORY_BALANCE=factory, QUOTE_BALANCE=quote,
                   RPC_ENV='MONAD_TESTNET_RPC_URL', KEY_ENV='DEPLOYER_PRIVATE_KEY', BC_ENV_ARGS='-l')
        return subprocess.run(['bash', str(self.root / 'script/seed-pool-testnet.sh'), '--dry-run'],
                              env=env, capture_output=True, text=True)

    def test_whole_token_floor_balance_refuses_before_forge(self):
        result = self.run_wrapper(factory='1000000000000000000')
        self.assertEqual(result.returncode, 3)
        self.assertIn('NEEDS FACTORY v2: at least 1666666666666666666 raw', result.stderr)
        self.assertFalse(self.calls.exists())

    def test_one_raw_unit_below_exact_need_refuses(self):
        result = self.run_wrapper(factory='1666666666666666665')
        self.assertEqual(result.returncode, 3)
        self.assertFalse(self.calls.exists())

    def test_exact_fractional_balance_passes_dry_run_without_broadcast(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(len(calls), 1)
        self.assertNotIn('--broadcast', calls[0])
        self.assertNotIn('--sig', calls[0])
        self.assertIn('1666666666666666666 FACTORY, 5000000 mUSD', result.stdout)
        self.assertIn('dry run passed (nothing broadcast)', result.stdout)

    def test_committed_ratio_stays_funded(self):
        self.record['liquidity'].update(factoryAmount=10000, quoteAmount=1, maxRepairCost=1)
        result = self.run_wrapper(factory=str(20000 * 10**18), quote='2000000')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('20000000000000000000000 FACTORY, 2000000 mUSD', result.stdout)

    def test_quote_shortfall_refuses_before_forge(self):
        result = self.run_wrapper(quote='4999999')
        self.assertEqual(result.returncode, 3)
        self.assertIn('NEEDS mUSD: 5 whole mUSD', result.stderr)
        self.assertFalse(self.calls.exists())

    def test_huge_digits_cannot_wrap_into_the_small_bounds(self):
        for field in ('factoryAmount', 'quoteAmount', 'maxRepairCost'):
            for value in (2**64 + 1, 10**96):
                with self.subTest(field=field, value=value):
                    before = self.record['liquidity'][field]
                    self.record['liquidity'][field] = value
                    result = self.run_wrapper()
                    self.assertEqual(result.returncode, 2)
                    self.assertRegex(result.stderr, 'invalid seed amounts|outside the small testnet seed bounds')
                    self.assertFalse(self.calls.exists())
                    self.record['liquidity'][field] = before


if __name__ == '__main__':
    unittest.main()
