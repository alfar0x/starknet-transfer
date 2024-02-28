import Big from "big.js";
import { CallData, Contract, Account, RpcProvider } from "starknet";
import { initDefaultLogger, readByLine } from "@alfar/helpers";

const SLEEP_BETWEEN_ACCOUNTS_SEC = 10 * 60;
const MAX_WITHDRAW_FEE_USD = 0.7;
const UPDATE_ETH_PRICE_MS = 15 * 60 * 1000;
const CHECK_FEE_SEC = 10 * 60;
const MAX_ERRORS = 3;
const MIN_USD_TO_TRANSFER = 5;

const STARKNET_RPC = "https://starknet-mainnet.public.blastapi.io";
const EXPLORER_URL = "https://starkscan.co/tx";
const ETH_ADDRESS =
  "0x049D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7";

let lastEthUpdateTimestamp = 0;
let ethPrice = null;

const logger = initDefaultLogger("debug");

const sleep = async (sec) => {
  logger.info(`sleep ${sec}s`);
  return await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
};

const getEthPrice = async () => {
  if (new Date().getTime() < lastEthUpdateTimestamp + UPDATE_ETH_PRICE_MS) {
    return ethPrice;
  }

  logger.info("updating eth price");

  const params = { ids: ["ethereum"], vs_currencies: "usd" };
  const urlParams = new URLSearchParams(params).toString();

  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?" + urlParams
  );
  const data = await response.json();

  ethPrice = data.ethereum.usd;

  lastEthUpdateTimestamp = new Date().getTime();

  return ethPrice;
};

const weiToUsd = async (wei) => {
  const ethPrice = await getEthPrice();
  const divider = Big(10).pow(18);
  return Big(wei).div(divider).times(ethPrice).round(2).toNumber();
};

const waitFee = async (account, tx) => {
  while (true) {
    const { suggestedMaxFee } = await account.estimateInvokeFee(tx);

    const feeUsd = await weiToUsd(suggestedMaxFee);

    if (feeUsd < MAX_WITHDRAW_FEE_USD) {
      logger.info(`good fee $${feeUsd}`);
      return suggestedMaxFee;
    }

    logger.info(`bad fee $${feeUsd}`);

    await sleep(CHECK_FEE_SEC);
  }
};

const waitTxStatus = async (provider, txHash) => {
  while (true) {
    const res = await provider.getTransactionReceipt(txHash);

    if (
      res.status === "ACCEPTED_ON_L2" &&
      res.finality_status === "ACCEPTED_ON_L2" &&
      res.execution_status === "SUCCEEDED"
    ) {
      return true;
    }

    if (res.status === "REJECTED" || res.execution_status === "REJECTED") {
      throw new Error("rejected");
    }

    if (res.status === "REVERTED" || res.execution_status === "REVERTED") {
      throw new Error("reverted");
    }

    await sleep(2);
  }
};

const transfer = async (provider, contract, prkey, address, recipient) => {
  const account = new Account(provider, address, prkey, 1);

  const balance = await contract.balanceOf(account.address);

  const usdBalance = await weiToUsd(balance);

  if (usdBalance < MIN_USD_TO_TRANSFER) {
    throw new Error(`usd balance too low $${usdBalance}`);
  }

  logger.info(`usd balance: $${usdBalance}`);

  const suggestedMaxFee = await waitFee(account, {
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

  await waitTxStatus(provider, transaction_hash);
};

const main = async () => {
  const data = readByLine("data.txt");

  let errors = 0;

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });

  const { abi } = await provider.getClassAt(ETH_ADDRESS);

  const contract = new Contract(abi, ETH_ADDRESS, provider);

  for (let idx = 0; idx < data.length; idx += 1) {
    const item = data[idx];
    const [name, prkey, address, recipient] = item.split(",");
    logger.info(`${idx}/${data.length} ${name}`);

    try {
      await transfer(provider, contract, prkey, address, recipient);
      errors = 0;
    } catch (error) {
      logger.error(error);
      errors += 1;
    }

    if (errors >= MAX_ERRORS) throw new Error("too much errors");

    await sleep(SLEEP_BETWEEN_ACCOUNTS_SEC);
  }
};

main();
