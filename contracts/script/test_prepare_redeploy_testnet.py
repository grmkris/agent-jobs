import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('prepare_redeploy_testnet.py')
spec = importlib.util.spec_from_file_location('prepare', SCRIPT)
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)


def fixture():
    config = json.loads((SCRIPT.parent.parent / 'config/monad-testnet.json').read_text())
    # Promotion-safe: retain the shipped inputs/history, synthesize G1 even after G1b becomes current.
    for dotted, value in prep.G1_IDENTITY['addresses'].items():
        at = config
        keys = dotted.split('.')
        for key in keys[:-1]:
            at = at.setdefault(key, {})
        at[keys[-1]] = value
    config['chainId'] = 10143
    config['network'] = 'monad-testnet'
    config['deployment']['main']['kind'] = 'hireling-v1'
    config['deployment']['hireling']['block'] = prep.G1_IDENTITY['hirelingBlock']
    config['deployment']['hireling']['t0'] = prep.G1_IDENTITY['t0']
    config['hireling']['clocks'] = prep.G1_IDENTITY['clocks']
    config['hireling']['reuseCore'] = True
    return config


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / 'monad-testnet.json'
        self.archive = self.config.parent / 'archive/monad-testnet-g1.json'
        self.record = fixture()
        self.source = (json.dumps(self.record, indent=2) + '\n').encode()
        self.config.write_bytes(self.source)

    def test_archive_preserves_verbatim_g1_and_prepare_only_removes_three_keys(self):
        prep.prepare(self.config, self.archive)
        archived = json.loads(self.archive.read_text())
        metadata = archived.pop('archive')
        self.assertEqual(archived, self.record)
        self.assertTrue(self.archive.read_bytes().startswith(self.source.rstrip()[:-1]))
        self.assertEqual(metadata['sourceSha256'], prep.hashlib.sha256(self.source).hexdigest())
        self.assertTrue(metadata['date'])
        self.assertIn('not a legacy stack', metadata['reason'])
        expected = copy.deepcopy(self.record)
        for key in ('hireling', 'main', 'oddTokens'):
            expected['deployment'].pop(key, None)
        self.assertEqual(json.loads(self.config.read_text()), expected)

    def test_check_writes_nothing(self):
        prep.prepare(self.config, self.archive, check=True)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())

    def test_existing_archive_refuses_without_changing_either_file(self):
        self.archive.parent.mkdir()
        self.archive.write_bytes(b'keep me')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            prep.prepare(self.config, self.archive)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertEqual(self.archive.read_bytes(), b'keep me')

    def test_chain_and_each_g1_address_mismatch_refuse_without_writes(self):
        for dotted in ['chainId', *prep.G1_IDENTITY['addresses']]:
            altered = copy.deepcopy(self.record)
            at = altered
            keys = dotted.split('.')
            for key in keys[:-1]:
                at = at[key]
            at[keys[-1]] = 143 if dotted == 'chainId' else '0x' + 'f' * 40
            source = json.dumps(altered).encode()
            self.config.write_bytes(source)
            with self.assertRaises(ValueError):
                prep.prepare(self.config, self.archive)
            self.assertEqual(self.config.read_bytes(), source)
            self.assertFalse(self.archive.exists())

    def test_unknown_output_refuses_instead_of_losing_it(self):
        self.record['deployment']['futureOutput'] = {'keep': 1}
        self.config.write_text(json.dumps(self.record))
        with self.assertRaisesRegex(ValueError, 'unknown deployment'):
            prep.prepare(self.config, self.archive)
        self.assertFalse(self.archive.exists())

    def test_symlink_source_refuses_without_archive(self):
        target = self.config.with_suffix('.original')
        self.config.rename(target)
        self.config.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            prep.prepare(self.config, self.archive)
        self.assertEqual(target.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())

    def test_concurrent_config_edit_keeps_original_archive_and_new_active_bytes(self):
        changed = self.source + b'\n'
        real_sync = prep.sync_directory

        def after_archive(path):
            real_sync(path)
            self.config.write_bytes(changed)

        with patch.object(prep, 'sync_directory', after_archive):
            with self.assertRaisesRegex(ValueError, 'config changed'):
                prep.prepare(self.config, self.archive)
        self.assertEqual(self.config.read_bytes(), changed)
        archive = json.loads(self.archive.read_text())
        archive.pop('archive')
        self.assertEqual(archive, self.record)
        self.assertFalse(list(self.config.parent.glob('.prepare-g1b-*')))
        with self.assertRaisesRegex(ValueError, 'already exists'):
            prep.prepare(self.config, self.archive)

    def test_shell_refuses_wrong_rpc_chain_before_file_mutation(self):
        fake = self.config.parent / 'cast'
        fake.write_text('#!/bin/sh\nprintf "143\\n"\n')
        fake.chmod(0o700)
        env = dict(prep.os.environ, PATH=str(fake.parent) + ':' + prep.os.environ['PATH'], MONAD_TESTNET_RPC_URL='http://unused.invalid')
        # Do not inherit another launch's lock; run against a disposable script copy/lock directory.
        root = self.config.parent / 'contracts'
        (root / 'script').mkdir(parents=True)
        for name in ('prepare-redeploy-testnet.sh', 'launch-lock.sh'):
            (root / 'script' / name).write_bytes((SCRIPT.parent / name).read_bytes())
        env.pop('LAUNCH_LOCK_HELD', None)
        env.pop('LAUNCH_LOCK_FILE', None)
        result = subprocess.run(['bash', str(root / 'script/prepare-redeploy-testnet.sh'), '--config', str(self.config), '--archive', str(self.archive)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('RPC chain 10143', result.stderr)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())


if __name__ == '__main__':
    unittest.main()
