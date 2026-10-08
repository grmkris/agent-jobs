// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SidequestRecipe} from "../script/SidequestRecipe.sol";

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
        s[0] = "MAINNET_GO=yes forge script script/DeploySidequest.s.sol";
        s[1] = "forge script script/PromoteSidequest.s.sol";
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
        string[] memory s = new string[](18);
        s[0] = "MAINNET_GO=yes forge script script/DeploySidequest.s.sol";
        s[1] = "forge script script/PromoteSidequest.s.sol";
        s[2] = live;
        s[3] = "production launch gate refused";
        // Before the Safe takes ownership: no module and no guard, which the mining fund's nonce guard needs (D18).
        s[4] = "getModulesPaginated(address,uint256)(address[],address)";
        s[5] = GUARD_SLOT;
        s[6] = "MAINNET_GO=yes forge script script/SafeAccept.s.sol";
        s[7] = "forge script script/SafeAccept.s.sol --sig \"check()\"";
        s[8] = live;
        s[9] = "Sidequest v1 production launch gate passed";
        // LAUNCH-AUDIT-003: the gate reads the reviewed Safe back against the artifact's pins.
        s[10] = "the reviewed Safe: storage slot 0 is the canonical SafeL2 singleton";
        s[11] = "MAINNET_GO=yes forge script script/SeedPool.s.sol";
        s[12] = "forge script script/SeedPool.s.sol --sig \"verify()\"";
        s[13] = "PROD_ADMISSION_DRAIN=1 bun run deploy:prod";
        s[14] = "Post-deploy probes";
        s[15] = "bun scripts/preflight-prod.ts docs/p0-prod-artifact.json --probe https://sidequest.exchange";
        s[16] = live;
        s[17] = "PROD_ADMISSION_DRAIN=0 bun run deploy:prod";
        _inOrder(doc, s, "runbook");
    }

    /// keccak256("guard_manager.guard.address"), Safe v1.4.1's guard storage slot.
    string internal constant GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

    /// U-FUND-SEC-001: the terminal fund path is /admin's (D18): the remainder from calls.fund, while its expect still
    /// matches totalFunded, signed as an ECDSA SafeTx at the nonce read with it, never pre-validated; R7 does the same,
    /// and the testnet launch refuses a Safe with a module or a guard.
    function test_fundIsNonceBoundEcdsa() public view {
        string memory root = vm.projectRoot();
        string memory readme = vm.readFile(string.concat(root, "/../scripts/mining/README.md"));
        string memory mine = vm.readFile(string.concat(root, "/script/RehearseHireAndMine.s.sol"));
        string memory launch = vm.readFile(string.concat(root, "/script/launch-testnet.sh"));
        string[5] memory runbook = [
            "calls.fund.expect.totalFunded",
            "NONCE=$(cast call --block \"$B\"",
            "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)",
            "SIG=$(cast wallet sign --no-hash \"$H\" \"${KEY[@]}\")",
            "Never use a pre-validated (v = 1) signature"
        ];
        for (uint256 i; i < runbook.length; ++i) {
            assertTrue(vm.contains(doc, runbook[i]), string.concat("runbook lacks ", runbook[i]));
        }
        assertFalse(vm.contains(doc, "fund(n, total)"), "runbook still funds the total");
        assertFalse(vm.contains(readme, "fund(n, total)"), "mining README still funds the total");
        assertTrue(vm.contains(readme, "calls.fund.expect.totalFunded"), "mining README lacks the expect check");
        assertTrue(vm.contains(readme, "Never use a pre-validated (v = 1) signature"), "mining README allows v = 1");
        assertTrue(vm.contains(mine, "vm.sign(ownerKey, fundHash)"), "R7 does not ECDSA-sign the fund");
        assertTrue(vm.contains(mine, "\"GS026\""), "R7 does not show the spent nonce refusing");
        assertTrue(
            vm.contains(launch, "getModulesPaginated(address,uint256)(address[],address)"), "launch: no module check"
        );
        assertTrue(vm.contains(launch, GUARD_SLOT), "launch: no guard check");
    }

    /// LAUNCH-AUDIT-003: D16 itself reads the Safe's singleton, VERSION, owners, threshold, modules and guard against the
    /// artifact's pins; the artifact has the fields; R7 runs the gate with its own Safe's pins and shows the refusals.
    function test_launchGateReadsTheReviewedSafe() public view {
        string memory root = vm.projectRoot();
        string memory gate = vm.readFile(string.concat(root, "/../apps/api/src/prod-config.ts"));
        string[8] memory reads = [
            "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
            GUARD_SLOT,
            "function VERSION() view returns (string)",
            "function getOwners() view returns (address[])",
            "function getThreshold() view returns (uint256)",
            "function getModulesPaginated(address start, uint256 pageSize)",
            "safeOwners",
            "safeThreshold"
        ];
        for (uint256 i; i < reads.length; ++i) {
            assertTrue(vm.contains(gate, reads[i]), string.concat("prod-config.ts lacks ", reads[i]));
        }
        assertTrue(vm.contains(doc, "`deployment.sidequest.safeOwners`"), "runbook does not pin the Safe owners");
        assertTrue(vm.contains(doc, "`deployment.sidequest.safeThreshold`"), "runbook does not pin the Safe threshold");
        assertTrue(
            vm.contains(
                r7,
                "liveLaunchGate(config, rpcReader(process.argv[3]), RELAY_FLOOR_MAINNET, JSON.parse(process.argv[4]))"
            ),
            "R7 gate without a Safe policy"
        );
        assertTrue(
            vm.contains(r7, "launch:safe owners differ from the pinned set"),
            "R7 does not show a wrong owner pin refusing"
        );
        assertTrue(vm.contains(r7, "launch:safe has a guard set"), "R7 does not show a guard refusing");
    }

    /// LAUNCH-AUDIT-001: runbook §1.2's `sidequest` table is a complete recipe input. A fixture built only from its rows
    /// (path and type) loads through SidequestRecipe.load; without one row it does not. FIX-003: the fixture is set as the `sidequest` object of a scratch copy of the shipped record, so this
    /// holds whatever that record holds: no block before R2, R2's own block after (replaced here).
    function test_documentedSidequestInputLoads() public {
        (string memory json, uint256 rows) = _documentedSidequest("");
        assertEq(rows, 17, "runbook: the sidequest table lists the 17 fields load reads");

        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory path_ = string.concat(vm.projectRoot(), "/config/.test-schema.json");
        vm.writeFile(path_, real);
        vm.writeJson('{"safe":"0x0000000000000000000000000000000000000bad"}', path_, ".sidequest");
        string[2] memory bases = [real, vm.readFile(path_)]; // as shipped, and with an R2 sidequest block
        for (uint256 i; i < 2; ++i) {
            vm.writeFile(path_, bases[i]);
            vm.writeJson(json, path_, ".sidequest");
            SidequestRecipe.Config memory c = SidequestRecipe.load(vm, ".test-schema");
            assertEq(c.chainId, 143);
            assertEq(c.safe, address(uint160(0xa000 + 1)));
            assertEq(c.genesis, 1);
        }
        (string memory short,) = _documentedSidequest("margin");
        vm.writeFile(path_, real);
        vm.writeJson(short, path_, ".sidequest");
        vm.expectRevert();
        this.loadSchema();
        vm.removeFile(path_);
    }

    function loadSchema() external view returns (uint256) {
        return SidequestRecipe.load(vm, ".test-schema").chainId;
    }

    /// The §1.2 table as a `sidequest` object (one fixture value per type), without the field named `skip`.
    function _documentedSidequest(string memory skip) internal view returns (string memory json, uint256 rows) {
        string[] memory lines = vm.split(doc, "\n");
        json = "{";
        string memory group = "";
        bool first = true;
        bool firstInGroup;
        for (uint256 i; i < lines.length; ++i) {
            string memory line = vm.trim(lines[i]);
            if (vm.indexOf(line, "| `sidequest.") != 0) continue;
            string[] memory cells = vm.split(line, "|");
            string memory path = vm.replace(vm.replace(vm.trim(cells[1]), "`", ""), "sidequest.", "");
            string memory kind = vm.trim(cells[2]);
            // The recipe reads only address/uint inputs; retired bool options are not inputs.
            if (_eq(kind, "bool")) continue;
            string memory value = _fixtureValue(kind, ++rows);
            if (_eq(path, skip)) continue;
            string[] memory parts = vm.split(path, ".");
            if (parts.length == 1) {
                if (bytes(group).length > 0) json = string.concat(json, "}");
                group = "";
                json = string.concat(json, first ? "" : ",", '"', parts[0], '":', value);
            } else {
                assertEq(parts.length, 2, string.concat("runbook: unexpected sidequest field ", path));
                if (!_eq(group, parts[0])) {
                    if (bytes(group).length > 0) json = string.concat(json, "}");
                    json = string.concat(json, first ? "" : ",", '"', parts[0], '":{');
                    group = parts[0];
                    firstInGroup = true;
                }
                json = string.concat(json, firstInGroup ? "" : ",", '"', parts[1], '":', value);
                firstInGroup = false;
            }
            first = false;
        }
        json = string.concat(json, bytes(group).length > 0 ? "}}" : "}");
    }

    function _fixtureValue(string memory kind, uint256 row) internal pure returns (string memory) {
        if (_eq(kind, "address")) return string.concat('"', vm.toString(address(uint160(0xa000 + row))), '"');
        if (_eq(kind, "uint")) return "1";
        if (_eq(kind, "uint[4]")) return "[0,1,2,3]";
        revert(string.concat("runbook: unknown sidequest field type ", kind));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// LAUNCH-AUDIT-006: every command in the runbook's code blocks says where it runs and which RPC it reads. A
    /// `forge script` runs inside an explicit contracts subshell that sources ../.env.local itself; every forge script and
    /// chain-reading cast names --rpc-url; the session is declared bash (read -rsp, pwcheck).
    function test_commandsNameTheirCwdEnvAndRpc() public view {
        assertTrue(
            vm.contains(doc, "interactive **bash** session at the repo root. Start it with `bash`"),
            "no bash declaration"
        );
        string[] memory lines = vm.split(doc, "\n");
        bool inBlock;
        bool subshell;
        string memory command = "";
        uint256 checked;
        for (uint256 i; i < lines.length; ++i) {
            string memory line = vm.trim(lines[i]);
            if (vm.indexOf(line, "```") == 0) {
                inBlock = !inBlock;
                command = "";
                subshell = false;
                continue;
            }
            if (!inBlock) continue;
            if (vm.contains(line, "(cd contracts && set -a && . ../.env.local && set +a")) subshell = true;
            if (vm.contains(line, "forge script")) {
                assertTrue(subshell, string.concat("runbook: forge script outside the contracts subshell: ", line));
            }
            command = string.concat(command, " ", line);
            bytes memory b = bytes(line);
            if (b.length > 0 && b[b.length - 1] == "\\") continue; // a continued command
            bool reads = vm.contains(command, "forge script") || vm.contains(command, "cast call")
                || vm.contains(command, "cast storage") || vm.contains(command, "cast send")
                || vm.contains(command, "cast block-number");
            if (reads) {
                ++checked;
                assertTrue(
                    vm.contains(command, "--rpc-url"), string.concat("runbook: a read without --rpc-url: ", command)
                );
            }
            command = "";
            subshell = false;
        }
        assertGt(checked, 10, "runbook: expected the launch commands");
    }

    /// LAUNCH-AUDIT-009: R7's post-seed tail in order: hire, mining:epoch, ECDSA fund, setRoot, the two claims; and
    /// runbook §4's epoch steps in order: mining:publish (validated against rootOf, uploaded, read back) after setRoot and
    /// before the claims, with its key and digest recorded.
    function test_postSeedOrderAndEpochPublication() public view {
        string[4] memory r7Tail = [
            "MAINNET_GO=yes forge script script/SeedPool.s.sol",
            "--tc RehearseHire --rpc-url",
            "bun ../scripts/mining/epoch.ts 0 --network monad-mainnet",
            "--tc RehearseMining --rpc-url"
        ];
        string[] memory tail = new string[](4);
        for (uint256 i; i < 4; ++i) {
            tail[i] = r7Tail[i];
        }
        _inOrder(r7, tail, "rehearse-launch.sh post-seed");

        string memory mine = vm.readFile(string.concat(vm.projectRoot(), "/script/RehearseHireAndMine.s.sol"));
        string[] memory mining = new string[](5);
        mining[0] = "vm.sign(ownerKey, fundHash)";
        mining[1] = "safe.execTransaction(address(reserve), 0, fundData";
        mining[2] = "_exec(safe, vm.addr(ownerKey), address(distributor), vm.envBytes(\"SETROOT_DATA\"))";
        mining[3] = "distributor.claim(0, worker,";
        mining[4] = "distributor.claim(0, creator,";
        _inOrder(mine, mining, "RehearseMining");

        string[] memory epoch = new string[](5);
        epoch[0] = "bun run mining:epoch <n> --network monad-mainnet";
        epoch[1] = "**`calls.fund`**";
        epoch[2] = "**`calls.setRoot`**";
        epoch[3] = "bun run mining:publish <dir>/epoch-<n>.json --stage prod";
        epoch[4] = "Each claim stakes the reward";
        _inOrder(doc, epoch, "runbook section 4");
        assertTrue(vm.contains(doc, "After `setRoot` and before any claim, publish"), "runbook: publish not placed");
        assertTrue(vm.contains(doc, "sha256sum <dir>/epoch-<n>.json"), "runbook does not record the file's digest");
        assertTrue(
            vm.contains(doc, "Record the key `mining/epoch-<n>.json` and the file's sha256"),
            "runbook does not record the R2 key and digest"
        );
        assertFalse(vm.contains(doc, "TODO (backend)"), "runbook still has the publish TODO");
        string memory root = vm.projectRoot();
        assertTrue(
            vm.contains(
                vm.readFile(string.concat(root, "/../package.json")),
                "\"mining:publish\": \"bun scripts/mining/publish.ts\""
            ),
            "package.json has no mining:publish"
        );
        assertTrue(
            vm.contains(
                vm.readFile(string.concat(root, "/../scripts/mining/README.md")),
                "bun run mining:publish <epoch-n.json> --stage dev|prod"
            ),
            "scripts/mining/README.md documents another mining:publish usage"
        );
    }

    /// LAUNCH-AUDIT-010: SeedPool sends four transactions, and the script, the runbook budget and SURFACE say so.
    function test_seedPoolIsFourTransactions() public view {
        string memory root = vm.projectRoot();
        assertTrue(
            vm.contains(
                vm.readFile(string.concat(root, "/script/SeedPool.s.sol")), "Four transactions: deploy the `SeedHelper`"
            ),
            "SeedPool.s.sol does not say four transactions"
        );
        assertTrue(
            vm.contains(doc, "| SeedPool: helper, 2 approvals, seed | 4 |"), "runbook budget: SeedPool is not 4 txs"
        );
        string memory surface = vm.readFile(string.concat(root, "/SURFACE.md"));
        assertTrue(vm.contains(surface, "The script sends four transactions from the"), "SURFACE does not say four");
        assertTrue(
            vm.contains(surface, "| SeedPool (helper, 2 approvals, seed) | 4 |"),
            "SURFACE budget: SeedPool is not 4 txs"
        );
        assertFalse(vm.contains(surface, "three transactions from the"), "SURFACE still says three");
    }

    function test_runbookCarriesBudgetFundingAndFallbackKey() public view {
        string[8] memory needles = [
            "32,282,526", // R7's launch gas limit
            "| arbitrator | `roles.arbitrator` (a fresh R2 key) | 0.11 |", // LAUNCH-AUDIT-007: the cancellation reserve
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
        string[4] memory banned = ["node scripts/preflight-prod", "--adopt", "--force", "--private-key \"$"];
        for (uint256 i; i < banned.length; ++i) {
            assertFalse(vm.contains(doc, banned[i]), string.concat("runbook still names ", banned[i]));
        }
    }

    function test_mainnetSignsFromKeystores() public view {
        string[12] memory needles = [
            "cast wallet import sidequest-deployer --interactive",
            "--account sidequest-deployer --password-file ~/.config/sidequest/deployer.password",
            "--account sidequest-safe-owner",
            "--account sidequest-liquidity",
            "--password-file ~/.config/sidequest/safe-owner.password",
            // KEYSTORE-SEC-002: an existing directory or file is tightened, and every signer is checked first.
            "chmod 700 ~/.config/sidequest",
            "rm -f ~/.config/sidequest/deployer.password",
            "chmod 600 ~/.config/sidequest/deployer.password",
            "pwcheck ~/.config/sidequest/deployer.password && \\",
            "pwcheck ~/.config/sidequest/safe-owner.password && \\",
            "pwcheck ~/.config/sidequest/liquidity.password && \\",
            // KEYSTORE-SEC-003: the mining price list is signed behind the same check.
            "pwcheck ~/.config/sidequest/safe-owner.password && bun scripts/mining/sign-prices.ts"
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
            string.concat(root, "/script/DeploySidequest.s.sol"),
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
        _has(string.concat(root, "/script/DeploySidequest.s.sol"), "function run()");
        _has(string.concat(root, "/script/PromoteSidequest.s.sol"), "function run()");
        _has(string.concat(root, "/script/SafeAccept.s.sol"), "function check()");
        _has(string.concat(root, "/script/SeedPool.s.sol"), "function verify()");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "process.argv.includes('--live')");
        _has(string.concat(root, "/../scripts/preflight-prod.ts"), "Sidequest v1 production launch gate passed");
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
