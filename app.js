import Big from "big.js";
import { CallData, Contract, Account, RpcProvider } from "starknet";
import { initDefaultLogger, readByLine } from "@alfar/helpers";

const SLEEP_BETWEEN_ACCOUNTS_SEC = 60 * 60;
const MAX_ERRORS = 3;
const MIN_ETH_TO_TRANSFER = 0.001;
const SLEEP_ON_ERROR_SEC = 2 * 60;

const STARKNET_RPC = "https://starknet-mainnet.public.blastapi.io";
const EXPLORER_URL = "https://starkscan.co/tx";
const ETH_ADDRESS =
  "0x049D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7";

const logger = initDefaultLogger("debug");

const sleep = async (sec) => {
  logger.info(`sleep ${sec}s`);
  return await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
};

const transfer = async (provider, contract, prkey, address, recipient) => {
  const account = new Account(provider, address, prkey, "1");

  const balance = await contract.balanceOf(account.address);
  const readableBalance = Big(balance).div(Big(10).pow(18)).toString();

  if (Big(readableBalance).lt(MIN_ETH_TO_TRANSFER)) {
    throw new Error(`balance too low ${readableBalance} eth`);
  }

  const { suggestedMaxFee } = await account.estimateInvokeFee({
    contractAddress: ETH_ADDRESS,
    entrypoint: "transfer",
    calldata: CallData.compile({
      recipient: recipient,
      amount: { low: balance, high: 0n },
    }),
  });

  const lowAmount = balance - suggestedMaxFee;

  const { transaction_hash } = await account.execute({
    contractAddress: ETH_ADDRESS,
    entrypoint: "transfer",
    calldata: CallData.compile({
      recipient: recipient,
      amount: { low: lowAmount, high: 0n },
    }),
  });

  logger.info(`${EXPLORER_URL}/${transaction_hash}`);

  await provider.waitForTransaction(transaction_hash, {
    successStates: ["ACCEPTED_ON_L2", "ACCEPTED_ON_L1`"],
    retryInterval: 2000,
  });
};

const main = async () => {
  const data = readByLine("data.txt");

  let errors = 0;

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });

  const { abi } = await provider.getClassAt(ETH_ADDRESS);

  const contract = new Contract(abi, ETH_ADDRESS, provider);

  for (let idx = 0; idx < data.length; idx += 1) {
    const item = data[idx];
    const [prkey, address, recipient] = item.split(",");
    logger.info(`${idx}/${data.length}`);

    try {
      await transfer(provider, contract, prkey, address, recipient);
      errors = 0;
      await sleep(SLEEP_BETWEEN_ACCOUNTS_SEC);
    } catch (error) {
      logger.error(error.message);
      errors += 1;
      if (errors >= MAX_ERRORS) throw new Error("too much errors");
      await sleep(SLEEP_ON_ERROR_SEC);
    }
  }
};

main();
