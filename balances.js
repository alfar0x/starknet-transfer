import fs from "fs";
import { Contract, RpcProvider } from "starknet";
import { readByLine } from "@alfar/helpers";
import Big from "big.js";

const STARKNET_RPC = "https://starknet-mainnet.public.blastapi.io";
const ETH_ADDRESS =
  "0x049D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7";
const ETH_PRICE = 3480;
const FILE_RESULT = "res.txt";

const sleep = async (sec) => {
  return await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
};

const main = async () => {
  const data = readByLine("data.txt");

  fs.writeFileSync(FILE_RESULT, "");

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });

  const { abi } = await provider.getClassAt(ETH_ADDRESS);

  const contract = new Contract(abi, ETH_ADDRESS, provider);

  let idx = 0;

  for (const address of data) {
    const balance = await contract.balanceOf(address);

    const divider = Big(10).pow(18);
    const usd = Big(balance).div(divider).times(ETH_PRICE).round(0).toNumber();
    const res = usd >= 1 ? usd : "";
    fs.appendFileSync(FILE_RESULT, `${res}\n`);
    console.log(idx, usd);
    idx += 1;
    await sleep(0.1);
  }
};

main();
