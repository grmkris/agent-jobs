// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice PROD-GATE-007: `docs/mainnet-runbook.md` is the v1 launch, in the order R7 (`script/rehearse-launch.sh`)
///         runs it, with the custody readback and the drained-then-open deploy gates, and no legacy deploy path. Each
///         script and entry point it names exists. Source-level only: R7 is what executes the sequence.
contract MainnetRunbookTest is Test {
    string internal doc;
    string internal r7;

    function setUp() public {
        doc = vm.readFile(string.concat(vm.projectRoot(), "/../docs/mainnet-runbook.md"));
        r7 = vm.readFile(string.concat(vm.projectRoot(), "/script/rehearse-launch.sh"));
    }

    /// The forge steps both documents share, in launch order.
    function _sharedSteps() internal pure returns (string[] memory s) {
        s = new string[](6);
        s[0] = "MAINNET_GO=yes forge script script/DeployHireling.s.sol";
        s[1] = "forge script script/PromoteHireling.s.sol";
        s[2] = "MAINNET_GO=yes forge script script/SafeAccept.s.sol";
        s[3] = "forge script script/SafeAccept.s.sol --sig \"check()\"";
        s[4] = "MAINNET_GO=yes forge script script/SeedPool.s.sol";
        s[5] = "forge script script/SeedPool.s.sol --sig \"verify()\"";
    }

    function test_runbookAndR7RunTheSameForgeSteps() public view {
        _inOrder(doc, _sharedSteps(), "runbook");
        _inOrder(r7, _sharedSteps(), "rehearse-launch.sh");
    }

    function test_runbookSequenceWithGates() public view {
        string memory live = "bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --live";
        string[] memory s = new string[](15);
        s[0] = "MAINNET_GO=yes forge script script/DeployHireling.s.sol";
        s[1] = "forge script script/PromoteHireling.s.sol";
        s[2] = live;
        s[3] = "production launch gate refused";
        s[4] = "MAINNET_GO=yes forge script script/SafeAccept.s.sol";
        s[5] = "forge script script/SafeAccept.s.sol --sig \"check()\"";
        s[6] = live;
        s[7] = "Hireling v1 production launch gate passed";
        s[8] = "MAINNET_GO=yes forge script script/SeedPool.s.sol";
        s[9] = "forge script script/SeedPool.s.sol --sig \"verify()\"";
        s[10] = "PROD_ADMISSION_DRAIN=1 pnpm deploy:prod";
        s[11] = "Post-deploy probes";
        s[12] = "bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --probe https://hireling.xyz";
        s[13] = live;
        s[14] = "PROD_ADMISSION_DRAIN=0 pnpm deploy:prod";
        _inOrder(doc, s, "runbook");
    }

    function test_runbookCarriesBudgetFundingAndFallbackKey() public view {
        string[7] memory needles = [
            "32,037,851", // R7's launch gas limit
            "RELAY_FLOOR_MAINNET",
            "| relay |",
            "| liquidity holder",
            "\"fee\": 10000",
            "\"tickSpacing\": 200",
            "PriceNotSet"
        ];
        for (uint256 i; i < needles.length; ++i) {
            assertTrue(vm.contains(doc, needles[i]), string.concat("runbook lacks ", needles[i]));
        }
    }

    function test_runbookHasNoLegacyPath() public view {
        // A raw key on a mainnet command line: keystores are mandatory there (--private-key is a testnet fallback).
        string[5] memory banned =
            ["Deploy.s.sol", "node scripts/preflight-prod", "--adopt", "--force", "--private-key \"$"];
        for (uint256 i; i < banned.length; ++i) {
            assertFalse(vm.contains(doc, banned[i]), string.concat("runbook still names ", banned[i]));
        }
    }

    function test_mainnetSignsFromKeystores() public view {
        string[11] memory needles = [
            "cast wallet import hireling-deployer --interactive",
            "--account hireling-deployer --password-file ~/.config/hireling/deployer.password",
            "--account hireling-safe-owner",
            "--account hireling-liquidity",
            "--password-file ~/.config/hireling/safe-owner.password",
            // KEYSTORE-SEC-002: an existing directory or file is tightened, and every signer is checked first.
            "chmod 700 ~/.config/hireling",
            "rm -f ~/.config/hireling/deployer.password",
            "chmod 600 ~/.config/hireling/deployer.password",
            "pwcheck ~/.config/hireling/deployer.password && bash -c",
            "pwcheck ~/.config/hireling/safe-owner.password && \\",
            "pwcheck ~/.config/hireling/liquidity.password && \\"
        ];
        for (uint256 i; i < needles.length; ++i) {
            assertTrue(vm.contains(doc, needles[i]), string.concat("runbook lacks ", needles[i]));
        }
    }

    /// KEYSTORE-SEC-001: no mainnet command anywhere it is documented passes a raw key; testnet examples may.
    function test_noMainnetRawKeyExamples() public view {
        string memory root = vm.projectRoot();
        string[5] memory paths = [
            string.concat(root, "/SURFACE.md"),
            string.concat(root, "/script/SeedPool.s.sol"),
            string.concat(root, "/script/DeployHireling.s.sol"),
            string.concat(root, "/script/SafeAccept.s.sol"),
            string.concat(root, "/../docs/mainnet-runbook.md")
        ];
        for (uint256 i; i < paths.length; ++i) {
            _noMainnetRawKey(paths[i]);
        }
    }

    /// A line passing a raw key (`--private-key $…`, `"…"` or `…`) may not be, or follow, a mainnet or any-network line.
    function _noMainnetRawKey(string memory path) internal view {
        bytes memory text = bytes(vm.readFile(path));
        string memory prev = "";
        uint256 start;
        for (uint256 i; i <= text.length; ++i) {
            if (i < text.length && text[i] != "\n") continue;
            bytes memory raw = new bytes(i - start);
            for (uint256 j; j < raw.length; ++j) {
                raw[j] = text[start + j];
            }
            string memory line = string(raw);
            bool rawKey = vm.contains(line, "--private-key $") || vm.contains(line, "--private-key \"")
                || vm.contains(line, unicode"--private-key …");
            assertFalse(
                rawKey && (_anyNetwork(line) || _anyNetwork(prev)),
                string.concat(path, ": a mainnet raw-key command: ", line)
            );
            prev = line;
            start = i + 1;
        }
    }

    function _anyNetwork(string memory line) internal pure returns (bool) {
        return vm.contains(line, "monad-mainnet") || vm.contains(line, "MAINNET_GO") || vm.contains(line, "<network>");
    }

    function test_namedScriptsExist() public view {
        string memory root = vm.projectRoot();
        _has(string.concat(root, "/script/DeployHireling.s.sol"), "function run()");
        _has(string.concat(root, "/script/PromoteHireling.s.sol"), "function run()");
        _has(string.concat(root, "/script/SafeAccept.s.sol"), "function check()");
        _has(string.concat(root, "/script/SeedPool.s.sol"), "function verify()");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "process.argv.includes('--live')");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "Hireling v1 production launch gate passed");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "process.argv.indexOf('--probe')");
        _has(string.concat(root, "/../package.json"), "\"deploy:prod\":");
    }

    function _has(string memory path, string memory needle) internal view {
        assertTrue(vm.contains(vm.readFile(path), needle), string.concat(path, " lacks ", needle));
    }

    /// Each needle must appear after the previous one.
    function _inOrder(string memory text, string[] memory needles, string memory what) internal pure {
        bytes memory rest = bytes(text);
        for (uint256 i; i < needles.length; ++i) {
            uint256 at = vm.indexOf(string(rest), needles[i]);
            assertTrue(at != type(uint256).max, string.concat(what, ": missing or out of order: ", needles[i]));
            rest = _tail(rest, at + bytes(needles[i]).length);
        }
    }

    function _tail(bytes memory b, uint256 start) internal pure returns (bytes memory out) {
        out = new bytes(b.length - start);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[start + i];
        }
    }
}
