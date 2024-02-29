import Big from "big.js";
import dotenv from "dotenv";
import { CallData, Contract, Account, RpcProvider } from "starknet";
import { initDefaultLogger, readByLine, Telegram } from "@alfar/helpers";

const SLEEP_BETWEEN_ACCOUNTS_SEC = 10 * 60;
const MAX_WITHDRAW_FEE_USD = 0.8;
const UPDATE_ETH_PRICE_MS = 15 * 60 * 1000;
const CHECK_FEE_SEC = 10 * 60;
const MAX_ERRORS = 3;
const MIN_USD_TO_TRANSFER = 5;
const SLEEP_ON_ERROR_SEC = 2 * 60;

const STARKNET_RPC = "https://starknet-mainnet.public.blastapi.io";
const EXPLORER_URL = "https://starkscan.co/tx";
const ETH_ADDRESS =
  "0x049D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7";

let lastEthUpdateTimestamp = 0;
let ethPrice = null;

dotenv.config();
const { TG_TOKEN, TG_CHAT_ID } = process.env;

const logger = initDefaultLogger("debug");
const telegram = new Telegram(TG_TOKEN, [Number(TG_CHAT_ID)]);

const tgSend = async (text) => {
  try {
    await telegram.sendMessage(text);
  } catch (error) {
    console.error(error);
    logger.error(error.message);
  }
};

const sleep = async (sec) => {
  logger.info(`sleep ${sec}s`);
  await tgSend(`sleep ${sec}s`);
  return await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
};

const getEthPrice = async () => {
  if (new Date().getTime() < lastEthUpdateTimestamp + UPDATE_ETH_PRICE_MS) {
    return ethPrice;
  }

  logger.info("updating eth price");
  await tgSend("updating eth price");

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
      await tgSend(`good fee $${feeUsd}`);
      return suggestedMaxFee;
    }

    logger.warn(`bad fee $${feeUsd}`);
    await tgSend(`bad fee $${feeUsd}`);

    await sleep(CHECK_FEE_SEC);
  }
};

const transfer = async (provider, contract, prkey, address, recipient) => {
  const account = new Account(provider, address, prkey, 1);

  const balance = await contract.balanceOf(account.address);

  const usdBalance = await weiToUsd(balance);

  if (usdBalance < MIN_USD_TO_TRANSFER) {
    throw new Error(`usd balance too low $${usdBalance}`);
  }

  await tgSend(`usd balance: $${usdBalance}`);

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
  await tgSend(`${EXPLORER_URL}/${transaction_hash}`);

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
    const [name, prkey, address, recipient] = item.split(",");
    await tgSend(`${idx}/${data.length} ${name}`);

    try {
      await transfer(provider, contract, prkey, address, recipient);
      errors = 0;
      await sleep(SLEEP_BETWEEN_ACCOUNTS_SEC);
    } catch (error) {
      console.error(error);
      logger.error(error.message);
      await tgSend(error.message);
      errors += 1;
      if (errors >= MAX_ERRORS) throw new Error("too much errors");
      await sleep(SLEEP_ON_ERROR_SEC);
    }
  }
};

main();
