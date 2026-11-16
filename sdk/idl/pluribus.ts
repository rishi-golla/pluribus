/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pluribus.json`.
 */
export type Pluribus = {
  "address": "6axStTWfYe5AGyVJHEAyxbtk7axbPu514xvZ1d6NKSgT",
  "metadata": {
    "name": "pluribus",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "accrue",
      "discriminator": [
        23,
        76,
        128,
        149,
        229,
        247,
        72,
        228
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "autopay",
      "discriminator": [
        75,
        61,
        9,
        69,
        65,
        194,
        168,
        229
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "lpMarket",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "whirlpool"
              }
            ]
          }
        },
        {
          "name": "whirlpool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                14,
                3,
                104,
                95,
                142,
                144,
                144,
                83,
                228,
                88,
                18,
                28,
                102,
                245,
                167,
                106,
                237,
                199,
                112,
                106,
                161,
                28,
                130,
                248,
                170,
                149,
                42,
                143,
                43,
                120,
                121,
                169
              ]
            }
          }
        },
        {
          "name": "positionMint"
        },
        {
          "name": "vaultNft"
        },
        {
          "name": "tickArrayLower"
        },
        {
          "name": "tickArrayUpper"
        },
        {
          "name": "baseAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lpMarket.baseMint",
                "account": "lpMarket"
              }
            ]
          }
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "whirlpoolVaultA",
          "writable": true
        },
        {
          "name": "usdcAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "usdcCollateralVault",
          "writable": true
        },
        {
          "name": "whirlpoolVaultB",
          "writable": true
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "whirlpoolProgram",
          "address": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
        }
      ],
      "args": []
    },
    {
      "name": "collectProtocolFees",
      "discriminator": [
        22,
        67,
        23,
        98,
        150,
        178,
        70,
        220
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "treasuryUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositLp",
      "discriminator": [
        83,
        107,
        16,
        26,
        26,
        20,
        130,
        56
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "lpMarket",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lpMarket.whirlpool",
                "account": "lpMarket"
              }
            ]
          }
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                14,
                3,
                104,
                95,
                142,
                144,
                144,
                83,
                228,
                88,
                18,
                28,
                102,
                245,
                167,
                106,
                237,
                199,
                112,
                106,
                161,
                28,
                130,
                248,
                170,
                149,
                42,
                143,
                43,
                120,
                121,
                169
              ]
            }
          }
        },
        {
          "name": "positionMint"
        },
        {
          "name": "ownerNft",
          "writable": true
        },
        {
          "name": "vaultNft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "depositToken",
      "discriminator": [
        11,
        156,
        96,
        218,
        39,
        163,
        180,
        19
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "asset"
          ]
        },
        {
          "name": "ownerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "draw",
      "discriminator": [
        61,
        40,
        62,
        184,
        31,
        176,
        24,
        130
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "health",
      "discriminator": [
        235,
        42,
        47,
        99,
        10,
        7,
        249,
        16
      ],
      "accounts": [
        {
          "name": "credit",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [],
      "returns": {
        "defined": {
          "name": "healthView"
        }
      }
    },
    {
      "name": "initAsset",
      "discriminator": [
        133,
        1,
        51,
        41,
        37,
        45,
        8,
        38
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "assetParams"
            }
          }
        }
      ]
    },
    {
      "name": "initLpMarket",
      "discriminator": [
        19,
        77,
        255,
        166,
        141,
        227,
        79,
        158
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "whirlpool"
        },
        {
          "name": "baseAsset",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseAsset.mint",
                "account": "asset"
              }
            ]
          }
        },
        {
          "name": "lpMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "whirlpool"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "liqCostBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "programData"
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "usdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "poolParams"
            }
          }
        },
        {
          "name": "demoMode",
          "type": "bool"
        }
      ]
    },
    {
      "name": "lendDeposit",
      "discriminator": [
        200,
        92,
        164,
        134,
        219,
        233,
        129,
        250
      ],
      "accounts": [
        {
          "name": "lender",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "lenderUsdc",
          "writable": true
        },
        {
          "name": "lenderShares",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "lendWithdraw",
      "discriminator": [
        240,
        84,
        185,
        14,
        212,
        128,
        52,
        45
      ],
      "accounts": [
        {
          "name": "lender",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "lenderUsdc",
          "writable": true
        },
        {
          "name": "lenderShares",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "liquidate",
      "discriminator": [
        223,
        179,
        226,
        125,
        48,
        46,
        39,
        74
      ],
      "accounts": [
        {
          "name": "liquidator",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "liquidatorUsdc",
          "writable": true
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "asset"
          ]
        },
        {
          "name": "liquidatorCollateral",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "repayAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "liquidateLp",
      "discriminator": [
        184,
        134,
        42,
        9,
        9,
        99,
        65,
        25
      ],
      "accounts": [
        {
          "name": "liquidator",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "liquidatorUsdc",
          "writable": true
        },
        {
          "name": "usdcAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "usdcCollateralVault",
          "writable": true
        },
        {
          "name": "positionMint"
        },
        {
          "name": "vaultNft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "nftTokenProgram"
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "liquidatorNft",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "nftTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "openAccount",
      "discriminator": [
        101,
        152,
        91,
        243,
        176,
        36,
        189,
        101
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "refreshTier",
      "discriminator": [
        176,
        222,
        190,
        38,
        34,
        114,
        58,
        191
      ],
      "accounts": [
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "repay",
      "discriminator": [
        234,
        103,
        67,
        82,
        208,
        234,
        219,
        166
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "payerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "repayFromCollateral",
      "discriminator": [
        18,
        238,
        49,
        67,
        209,
        73,
        127,
        41
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "credit.owner",
                "account": "creditAccount"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "usdcAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "usdcCollateralVault",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setAdmin",
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setAsset",
      "discriminator": [
        243,
        216,
        48,
        30,
        63,
        58,
        91,
        239
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "assetParams"
            }
          }
        }
      ]
    },
    {
      "name": "setDemoPrice",
      "discriminator": [
        9,
        174,
        93,
        13,
        189,
        204,
        41,
        119
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        },
        {
          "name": "demoPrice",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  109,
                  111,
                  95,
                  112,
                  114,
                  105,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "conf",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setFlags",
      "discriminator": [
        199,
        54,
        111,
        124,
        87,
        47,
        217,
        198
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        },
        {
          "name": "demoMode",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setLpMarket",
      "discriminator": [
        195,
        82,
        227,
        216,
        135,
        36,
        129,
        197
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "lpMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lpMarket.whirlpool",
                "account": "lpMarket"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "liqCostBps",
          "type": "u16"
        },
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setParams",
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "poolParams"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawLp",
      "discriminator": [
        225,
        221,
        45,
        211,
        49,
        60,
        51,
        163
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "positionMint"
        },
        {
          "name": "vaultNft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "positionMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerNft",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawToken",
      "discriminator": [
        136,
        235,
        181,
        5,
        101,
        109,
        57,
        81
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "credit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  100,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "asset"
          ]
        },
        {
          "name": "ownerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "asset",
      "discriminator": [
        234,
        180,
        241,
        252,
        139,
        224,
        160,
        8
      ]
    },
    {
      "name": "creditAccount",
      "discriminator": [
        196,
        171,
        234,
        132,
        239,
        255,
        21,
        96
      ]
    },
    {
      "name": "demoPrice",
      "discriminator": [
        219,
        123,
        184,
        86,
        216,
        122,
        223,
        50
      ]
    },
    {
      "name": "lpMarket",
      "discriminator": [
        165,
        11,
        102,
        186,
        12,
        218,
        8,
        106
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    }
  ],
  "events": [
    {
      "name": "accountOpened",
      "discriminator": [
        250,
        89,
        39,
        67,
        35,
        119,
        126,
        63
      ]
    },
    {
      "name": "badDebt",
      "discriminator": [
        192,
        33,
        54,
        41,
        223,
        158,
        37,
        34
      ]
    },
    {
      "name": "collateralChanged",
      "discriminator": [
        172,
        114,
        48,
        57,
        98,
        83,
        95,
        157
      ]
    },
    {
      "name": "demoPriceSet",
      "discriminator": [
        119,
        103,
        177,
        33,
        71,
        73,
        51,
        129
      ]
    },
    {
      "name": "drawn",
      "discriminator": [
        87,
        120,
        94,
        189,
        167,
        148,
        44,
        221
      ]
    },
    {
      "name": "lenderMoved",
      "discriminator": [
        147,
        195,
        149,
        85,
        203,
        175,
        52,
        196
      ]
    },
    {
      "name": "liquidated",
      "discriminator": [
        231,
        57,
        55,
        75,
        0,
        170,
        246,
        68
      ]
    },
    {
      "name": "protocolFeesCollected",
      "discriminator": [
        165,
        34,
        125,
        155,
        15,
        86,
        99,
        191
      ]
    },
    {
      "name": "repaid",
      "discriminator": [
        38,
        248,
        231,
        7,
        150,
        164,
        172,
        23
      ]
    },
    {
      "name": "tierChanged",
      "discriminator": [
        126,
        9,
        150,
        127,
        199,
        123,
        136,
        1
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "invalidParams",
      "msg": "Invalid parameters"
    },
    {
      "code": 6003,
      "name": "paused",
      "msg": "Asset or pool is paused"
    },
    {
      "code": 6004,
      "name": "depositCap",
      "msg": "Deposit cap reached"
    },
    {
      "code": 6005,
      "name": "tooManyPositions",
      "msg": "No free position slot"
    },
    {
      "code": 6006,
      "name": "positionNotFound",
      "msg": "Position not found"
    },
    {
      "code": 6007,
      "name": "insufficientCollateral",
      "msg": "Not enough collateral in the position"
    },
    {
      "code": 6008,
      "name": "missingAccount",
      "msg": "Missing account for the health check"
    },
    {
      "code": 6009,
      "name": "accountMismatch",
      "msg": "Account does not match the position"
    },
    {
      "code": 6010,
      "name": "wrongOwner",
      "msg": "Account has the wrong owner program"
    },
    {
      "code": 6011,
      "name": "invalidPriceAccount",
      "msg": "Price account is not valid for this asset"
    },
    {
      "code": 6012,
      "name": "stalePrice",
      "msg": "Price is stale"
    },
    {
      "code": 6013,
      "name": "priceTooUncertain",
      "msg": "Price confidence interval is too wide"
    },
    {
      "code": 6014,
      "name": "invalidLpPosition",
      "msg": "Not an Orca Whirlpool position"
    },
    {
      "code": 6015,
      "name": "poolNotWhitelisted",
      "msg": "Whirlpool is not whitelisted"
    },
    {
      "code": 6016,
      "name": "unsupportedMint",
      "msg": "Only classic SPL Token mints can be collateral"
    },
    {
      "code": 6017,
      "name": "exceedsCreditLimit",
      "msg": "Debt would exceed the credit limit"
    },
    {
      "code": 6018,
      "name": "notLiquidatable",
      "msg": "Account is healthy"
    },
    {
      "code": 6019,
      "name": "healthNotImproved",
      "msg": "Liquidation would not improve health"
    },
    {
      "code": 6020,
      "name": "insufficientLiquidity",
      "msg": "Not enough liquidity in the pool"
    },
    {
      "code": 6021,
      "name": "poolInsolvent",
      "msg": "Pool has no lender assets left"
    },
    {
      "code": 6022,
      "name": "demoDisabled",
      "msg": "Demo feed is disabled"
    },
    {
      "code": 6023,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can initialize the pool"
    }
  ],
  "types": [
    {
      "name": "accountOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "asset",
      "docs": [
        "A whitelisted collateral token"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "totalDeposited",
            "type": "u64"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "assetParams"
              }
            }
          }
        ]
      }
    },
    {
      "name": "assetParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "group",
            "docs": [
              "Column in the shock tables, where anything >= MAX_GROUPS is never shocked"
            ],
            "type": "u8"
          },
          {
            "name": "oracle",
            "type": "u8"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "liqCostBps",
            "type": "u16"
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u32"
          },
          {
            "name": "maxConfBps",
            "type": "u16"
          },
          {
            "name": "depositCap",
            "type": "u64"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "badDebt",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "loss",
            "type": "u64"
          },
          {
            "name": "coveredByReserves",
            "type": "u64"
          },
          {
            "name": "coveredByProtocolFees",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "collateralChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "deposit",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "creditAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "healthySince",
            "type": "i64"
          },
          {
            "name": "debtShares",
            "type": "u128"
          },
          {
            "name": "positions",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "position"
                  }
                },
                5
              ]
            }
          }
        ]
      }
    },
    {
      "name": "demoPrice",
      "docs": [
        "Admin-written price that replaces Pyth while `Pool::demo_mode` is on"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "publishTime",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "demoPriceSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "drawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "debt",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "healthView",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "debt",
            "type": "u64"
          },
          {
            "name": "creditLimit",
            "type": "u64"
          },
          {
            "name": "liquidationLimit",
            "type": "u64"
          },
          {
            "name": "collateralValue",
            "type": "u64"
          },
          {
            "name": "borrowRateBps",
            "type": "u16"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "positionValue",
            "type": {
              "array": [
                "u64",
                5
              ]
            }
          },
          {
            "name": "positionPrice",
            "type": {
              "array": [
                "u64",
                5
              ]
            }
          }
        ]
      }
    },
    {
      "name": "lenderMoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lender",
            "type": "pubkey"
          },
          {
            "name": "usdc",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "deposit",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "liquidated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "liquidator",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "repaid",
            "type": "u64"
          },
          {
            "name": "seized",
            "type": "u64"
          },
          {
            "name": "debt",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "lpMarket",
      "docs": [
        "A whitelisted Orca Whirlpool whose positions count as collateral, always quoted in USDC"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "whirlpool",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "liqCostBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "pool",
      "docs": [
        "The single USDC lending pool plus protocol config"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "usdcVault",
            "type": "pubkey"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "demoMode",
            "docs": [
              "When set, prices come from admin-written demo accounts instead of Pyth"
            ],
            "type": "bool"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "poolParams"
              }
            }
          },
          {
            "name": "cash",
            "docs": [
              "USDC held for lenders and reserves, tracked here so stray transfers cannot move the share price"
            ],
            "type": "u64"
          },
          {
            "name": "reserves",
            "docs": [
              "Insurance fund: a claim on pool assets that absorbs bad debt before lenders"
            ],
            "type": "u64"
          },
          {
            "name": "protocolFees",
            "docs": [
              "Protocol revenue the admin can collect, also a claim on pool assets"
            ],
            "type": "u64"
          },
          {
            "name": "badDebt",
            "type": "u64"
          },
          {
            "name": "lastAccrual",
            "type": "i64"
          },
          {
            "name": "minLiqCostBps",
            "docs": [
              "Lowest liquidation cost any priced asset or LP market has been given, which caps the liquidation bonus"
            ],
            "type": "u16"
          },
          {
            "name": "borrowIndex",
            "docs": [
              "One borrow index per loyalty tier, since a shared index cannot charge different rates"
            ],
            "type": {
              "array": [
                "u128",
                3
              ]
            }
          },
          {
            "name": "debtShares",
            "type": {
              "array": [
                "u128",
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "poolParams",
      "docs": [
        "Admin-set risk and rate parameters",
        "Shocks are a scenario-by-group table in bps: row = scenario, column = risk group"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "numScenarios",
            "type": "u8"
          },
          {
            "name": "initShockBps",
            "docs": [
              "Applied when debt grows or collateral leaves"
            ],
            "type": {
              "array": [
                "u16",
                16
              ]
            }
          },
          {
            "name": "maintShockBps",
            "docs": [
              "Applied when deciding whether an account can be liquidated"
            ],
            "type": {
              "array": [
                "u16",
                16
              ]
            }
          },
          {
            "name": "liqBonusBps",
            "type": "u16"
          },
          {
            "name": "closeFactorBps",
            "type": "u16"
          },
          {
            "name": "warnHealthBps",
            "docs": [
              "Health under this drops the account to the base rate tier"
            ],
            "type": "u16"
          },
          {
            "name": "baseRateBps",
            "type": "u16"
          },
          {
            "name": "slope1Bps",
            "type": "u16"
          },
          {
            "name": "slope2Bps",
            "type": "u16"
          },
          {
            "name": "kinkBps",
            "type": "u16"
          },
          {
            "name": "reserveFactorBps",
            "docs": [
              "Share of borrower interest kept as the insurance reserve"
            ],
            "type": "u16"
          },
          {
            "name": "protocolFeeBps",
            "docs": [
              "Share of borrower interest the protocol keeps as revenue"
            ],
            "type": "u16"
          },
          {
            "name": "tierDiscountBps",
            "type": {
              "array": [
                "u16",
                3
              ]
            }
          },
          {
            "name": "tierMinHealthySecs",
            "type": {
              "array": [
                "i64",
                3
              ]
            }
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "mint",
            "docs": [
              "Token mint, or the Orca position NFT mint"
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Token base units, or 1 for an LP position"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump of Orca's address for an LP position, so the health check can confirm it cheaply"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "protocolFeesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "repaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "debt",
            "type": "u64"
          },
          {
            "name": "source",
            "docs": [
              "Where the USDC came from: 0 wallet, 1 autopay from LP fees, 2 the account's own USDC collateral"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "tierChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": "pubkey"
          },
          {
            "name": "from",
            "type": "u8"
          },
          {
            "name": "to",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "assetSeed",
      "type": "bytes",
      "value": "[97, 115, 115, 101, 116]"
    },
    {
      "name": "creditSeed",
      "type": "bytes",
      "value": "[99, 114, 101, 100, 105, 116]"
    },
    {
      "name": "demoPriceSeed",
      "type": "bytes",
      "value": "[100, 101, 109, 111, 95, 112, 114, 105, 99, 101]"
    },
    {
      "name": "lpMarketSeed",
      "type": "bytes",
      "value": "[108, 112, 95, 109, 97, 114, 107, 101, 116]"
    },
    {
      "name": "poolSeed",
      "type": "bytes",
      "value": "[112, 111, 111, 108]"
    },
    {
      "name": "shareMintSeed",
      "type": "bytes",
      "value": "[115, 104, 97, 114, 101, 95, 109, 105, 110, 116]"
    },
    {
      "name": "usdcVaultSeed",
      "type": "bytes",
      "value": "[117, 115, 100, 99, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
