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


def set_at(config, dotted, value):
    keys = dotted.split('.')
    for key in keys[:-1]:
        config = config[int(key)] if isinstance(config, list) else config.setdefault(key, {})
    key = keys[-1]
    if isinstance(config, list):
        config[int(key)] = value
    else:
        config[key] = value


def fixture(from_name='g1'):
    config = json.loads((SCRIPT.parent.parent / 'config/monad-testnet.json').read_text())
    # Promotion-safe: retain the shipped inputs/history, synthesize G1 even after G1b becomes current.
    identity = prep.IDENTITIES[from_name]
    for dotted, value in identity['addresses'].items():
        set_at(config, dotted, value)
    config['chainId'] = 10143
    config['network'] = 'monad-testnet'
    config['deployment']['main']['kind'] = 'sidequest-v1'
    config['deployment']['sidequest']['block'] = identity['sidequestBlock']
    config['deployment']['sidequest']['t0'] = identity['t0']
    config['sidequest']['clocks'] = identity['clocks']
    config['sidequest']['reuseCore'] = True
    return config


class PrepareTest(unittest.TestCase):
    from_name = 'g1'
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / 'monad-testnet.json'
        self.archive = self.config.parent / f'archive/monad-testnet-{self.from_name}.json'
        self.record = fixture(self.from_name)
        self.source = (json.dumps(self.record, indent=2) + '\n').encode()
        self.config.write_bytes(self.source)

    def test_archive_preserves_verbatim_g1_and_prepare_only_removes_three_keys(self):
        prep.prepare(self.config, self.archive, from_name=self.from_name)
        archived = json.loads(self.archive.read_text())
        metadata = archived.pop('archive')
        self.assertEqual(archived, self.record)
        self.assertTrue(self.archive.read_bytes().startswith(self.source.rstrip()[:-1]))
        self.assertEqual(metadata['sourceSha256'], prep.hashlib.sha256(self.source).hexdigest())
        self.assertTrue(metadata['date'])
        self.assertEqual(metadata['reason'], prep.IDENTITIES[self.from_name]['reason'])
        expected = copy.deepcopy(self.record)
        for key in ('sidequest', 'main', 'oddTokens'):
            expected['deployment'].pop(key, None)
        self.assertEqual(json.loads(self.config.read_text()), expected)

    def test_check_writes_nothing(self):
        prep.prepare(self.config, self.archive, from_name=self.from_name, check=True)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())

    def test_existing_archive_refuses_without_changing_either_file(self):
        self.archive.parent.mkdir()
        self.archive.write_bytes(b'keep me')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            prep.prepare(self.config, self.archive, from_name=self.from_name)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertEqual(self.archive.read_bytes(), b'keep me')

    def test_chain_and_each_g1_address_mismatch_refuse_without_writes(self):
        for dotted in ['chainId', *prep.IDENTITIES[self.from_name]['addresses']]:
            altered = copy.deepcopy(self.record)
            set_at(altered, dotted, 143 if dotted == 'chainId' else '0x' + 'f' * 40)
            source = json.dumps(altered).encode()
            self.config.write_bytes(source)
            with self.assertRaises(ValueError):
                prep.prepare(self.config, self.archive, from_name=self.from_name)
            self.assertEqual(self.config.read_bytes(), source)
            self.assertFalse(self.archive.exists())

    def test_unknown_output_refuses_instead_of_losing_it(self):
        self.record['deployment']['futureOutput'] = {'keep': 1}
        self.config.write_text(json.dumps(self.record))
        with self.assertRaisesRegex(ValueError, 'unknown deployment'):
            prep.prepare(self.config, self.archive, from_name=self.from_name)
        self.assertFalse(self.archive.exists())

    def test_symlink_source_refuses_without_archive(self):
        target = self.config.with_suffix('.original')
        self.config.rename(target)
        self.config.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            prep.prepare(self.config, self.archive, from_name=self.from_name)
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
                prep.prepare(self.config, self.archive, from_name=self.from_name)
        self.assertEqual(self.config.read_bytes(), changed)
        archive = json.loads(self.archive.read_text())
        archive.pop('archive')
        self.assertEqual(archive, self.record)
        self.assertFalse(list(self.config.parent.glob('.prepare-*')))
        with self.assertRaisesRegex(ValueError, 'already exists'):
            prep.prepare(self.config, self.archive, from_name=self.from_name)

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
        result = subprocess.run(['bash', str(root / 'script/prepare-redeploy-testnet.sh'), '--from', self.from_name, '--config', str(self.config), '--archive', str(self.archive)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('RPC chain 10143', result.stderr)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())


    def test_cli_requires_an_explicit_generation_before_any_write(self):
        result = subprocess.run(['python3', str(SCRIPT), '--config', str(self.config), '--archive', str(self.archive)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--from', result.stderr)
        self.assertEqual(self.config.read_bytes(), self.source)
        self.assertFalse(self.archive.exists())


class PrepareG1bTest(PrepareTest):
    from_name = 'g1b'

    def test_reviewed_identity_pins_g1b_metadata_and_new_addresses(self):
        identity = prep.IDENTITIES[self.from_name]
        self.assertEqual(identity['sidequestBlock'], 67856884)
        self.assertEqual(identity['t0'], 1791038852)
        for dotted in ['erc8004.identity', 'erc8004.reputation', 'deployment.oddTokens.blocklist', 'deployment.oddTokens.gasBurner', 'deployment.sidequest.vault', 'deployment.main.holding']:
            self.assertIn(dotted, identity['addresses'])
        self.assertEqual(identity['reason'], 'G1b archived for the G1c delegated-stake redeploy (ADR-0014)')


if __name__ == '__main__':
    unittest.main()
