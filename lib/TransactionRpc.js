'use strict';

require('classtool');


function spec() {
  var RpcClient       = require('bitcore/RpcClient').class(),
//      networks         = require('bitcore/network'),
      BitcoreTransaction = require('bitcore/Transaction').class(),
      BitcoreBlock = require('bitcore/Block').class(),
      util         = require('bitcore/util/util'),
      config       = require('../config/config');

  function TransactionRpc() {
    this.dummy = null;
  }

  TransactionRpc._parseRpcResult = function(info) {
    var b  = new Buffer(info.hex,'hex');
    var tx = new BitcoreTransaction();
    tx.parse(b);

    // Inputs
    if (tx.isCoinBase())  {
      info.isCoinBase = true;

      var reward =  BitcoreBlock.getBlockValue(info.height) / util.COIN;
      info.vin[0].reward = reward;
      info.valueIn = reward;
    }

    var n =0;
    info.vin.forEach(function(i) {
      i.n = n++;
    });

    // Outputs
    var valueOut = 0;
    info.vout.forEach( function(o) {
      valueOut += o.value * util.COIN;
    });
    info.valueOut = valueOut / util.COIN;
    info.size     = b.length;

    return info;
  };

  TransactionRpc.getRpcInfo = function(txid,  cb) {
    var Self = this;

    var rpc  = new RpcClient(config.bitcoind);

    rpc.getRawTransaction(txid, 1, function(err, txInfo) {

      // Not found?
      if (err && err.code === -5) return cb();
      if (err) return cb(err);

      var info = Self._parseRpcResult(txInfo.result);

      return cb(null,info);
    });
  };

  return TransactionRpc;
}
module.defineClass(spec);

