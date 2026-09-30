pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Recipe} from "../script/Recipe.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

contract MetadataWriter is Deploy {
    function write(Recipe.Config memory config, Recipe.Deployed memory deployed) external {
        _write("e38-metadata-test", config, deployed);
    }
}

contract DeploymentMetadataTest is Base {
    function test_firstDeployPersistsOpenTokens() public {
        Recipe.Config memory config;
        config.stackNames = new string[](1);
        config.stackNames[0] = "main";
        Recipe.Deployed memory deployed;
        deployed.core = core;
        deployed.factory = factory;
        deployed.rewardTokens = new address[](1);
        deployed.rewardTokens[0] = address(pay);
        deployed.holdings = new JobHolding[](1);
        deployed.holdings[0] = holding;
        deployed.evaluators = new JobsEvaluator[](1);
        deployed.evaluators[0] = evaluator;
        string memory path = string.concat(vm.projectRoot(), "/config/e38-metadata-test.json");
        require(!vm.exists(path), "disposable path already exists");
        vm.writeFile(path, "{\"deployment\":{}}");
        new MetadataWriter().write(config, deployed);
        string memory json = vm.readFile(path);
        assertTrue(vm.parseJsonBool(json, ".deployment.main.openTokens"));
        assertEq(vm.parseJsonAddress(json, ".deployment.main.holding"), address(holding));
        assertEq(vm.parseJsonAddress(json, ".deployment.main.evaluator"), address(evaluator));
        vm.removeFile(path);
    }
}
