/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pluribus.json`.
 */
export type Pluribus = {
  "address": "6Jipm4bxEr5mrvfQn6na12EkB1ALSyh7nk7hwybpQsny",
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
      "name": "applyAsset",
      "discriminator": [
        3,
        125,
        44,
        60,
        227,
        210,
        36,
        250
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
      "args": []
    },
    {
      "name": "applyLpMarket",
      "discriminator": [
        120,
        78,
        121,
        241,
        39,
        113,
        96,
        70
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
      "args": []
    },
    {
      "name": "applyParams",
      "discriminator": [
        188,
        203,
        86,
        124,
        178,
        34,
        133,
        116
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
      "name": "cancelJuniorExit",
      "discriminator": [
        113,
        84,
        140,
        26,
        53,
        118,
        47,
        93
      ],
      "accounts": [
        {
          "name": "caller",
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
          "name": "owner",
          "writable": true
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  120,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "exit.owner",
                "account": "juniorExit"
              }
            ]
          }
        },
        {
          "name": "juniorMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "juniorEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "ownerJunior",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "cancelPendingParams",
      "discriminator": [
        86,
        110,
        207,
        152,
        11,
        166,
        48,
        1
      ],
      "accounts": [
        {
          "name": "guard",
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
        }
      ],
      "args": []
    },
    {
      "name": "claimJuniorExit",
      "discriminator": [
        239,
        187,
        86,
        222,
        84,
        255,
        157,
        126
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
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
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  120,
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
          "name": "juniorMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "juniorEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
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
          "name": "payout",
          "docs": [
            "USDC to be paid in cash, or senior shares to be paid in those"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram"
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
      "name": "convertToJunior",
      "discriminator": [
        0,
        255,
        188,
        80,
        153,
        148,
        59,
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
          "name": "shareMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "juniorMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "lenderShares",
          "writable": true
        },
        {
          "name": "lenderJunior",
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
          "name": "baseAsset",
          "docs": [
            "The LP's priced token, whose own pause and activation delay apply to its LPs too"
          ],
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
      "name": "guardAsset",
      "discriminator": [
        58,
        68,
        14,
        218,
        98,
        171,
        69,
        251
      ],
      "accounts": [
        {
          "name": "guard",
          "signer": true
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
      "args": []
    },
    {
      "name": "guardLpMarket",
      "discriminator": [
        205,
        190,
        210,
        122,
        102,
        23,
        242,
        98
      ],
      "accounts": [
        {
          "name": "guard",
          "signer": true
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
      "args": []
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
      "name": "initJunior",
      "discriminator": [
        200,
        247,
        76,
        50,
        200,
        146,
        120,
        208
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
          "name": "juniorMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
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
          "name": "juniorEscrow",
          "docs": [
            "Holds junior shares while they wait in the exit queue"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
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
      "args": []
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
          "docs": [
            "The senior or junior share mint, checked against the pool in the handler"
          ],
          "writable": true
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
          "docs": [
            "The senior or junior share mint, checked against the pool in the handler"
          ],
          "writable": true
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
      "name": "pauseJuniorExits",
      "discriminator": [
        229,
        103,
        176,
        164,
        102,
        19,
        255,
        199
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
          "name": "durationSecs",
          "type": "u32"
        }
      ]
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
      "name": "requestJuniorExit",
      "discriminator": [
        161,
        110,
        172,
        213,
        80,
        138,
        252,
        167
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
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
          "name": "juniorMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "ownerJunior",
          "writable": true
        },
        {
          "name": "juniorEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  117,
                  110,
                  105,
                  111,
                  114,
                  95,
                  101,
                  120,
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
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
      "name": "setGuardian",
      "discriminator": [
        147,
        243,
        50,
        121,
        154,
        164,
        50,
        30
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
          "name": "guardian",
          "type": "pubkey"
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
      "name": "unpauseJuniorExits",
      "discriminator": [
        1,
        172,
        5,
        107,
        124,
        109,
        90,
        127
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
      "args": []
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
      "name": "juniorExit",
      "discriminator": [
        234,
        76,
        106,
        173,
        150,
        51,
        122,
        168
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
      "name": "changeApplied",
      "discriminator": [
        226,
        1,
        224,
        100,
        192,
        110,
        58,
        24
      ]
    },
    {
      "name": "changeCancelled",
      "discriminator": [
        139,
        179,
        97,
        81,
        214,
        21,
        119,
        93
      ]
    },
    {
      "name": "changeQueued",
      "discriminator": [
        232,
        143,
        80,
        230,
        125,
        117,
        169,
        213
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
      "name": "juniorExitCancelled",
      "discriminator": [
        252,
        140,
        99,
        200,
        121,
        2,
        52,
        89
      ]
    },
    {
      "name": "juniorExitClaimed",
      "discriminator": [
        56,
        77,
        146,
        152,
        107,
        115,
        9,
        181
      ]
    },
    {
      "name": "juniorExitRequested",
      "discriminator": [
        83,
        199,
        184,
        206,
        130,
        212,
        249,
        165
      ]
    },
    {
      "name": "juniorExitsPaused",
      "discriminator": [
        80,
        99,
        49,
        150,
        9,
        52,
        73,
        73
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
    },
    {
      "name": "trancheConverted",
      "discriminator": [
        249,
        121,
        88,
        27,
        39,
        181,
        244,
        199
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
      "name": "demoDisabled",
      "msg": "Demo feed is disabled"
    },
    {
      "code": 6022,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can initialize the pool"
    },
    {
      "code": 6023,
      "name": "juniorExitQueue",
      "msg": "Junior shares leave through the exit queue"
    },
    {
      "code": 6024,
      "name": "exitsPaused",
      "msg": "Junior exits are paused by governance"
    },
    {
      "code": 6025,
      "name": "exitNotReady",
      "msg": "The exit is still in its waiting period"
    },
    {
      "code": 6026,
      "name": "exitLapsed",
      "msg": "The exit lapsed: its claim window has passed"
    },
    {
      "code": 6027,
      "name": "exitNotLapsed",
      "msg": "Only the owner can cancel an exit before it lapses"
    },
    {
      "code": 6028,
      "name": "pauseNotAllowed",
      "msg": "A pause must fit the cap and follow the last one by the required gap"
    },
    {
      "code": 6029,
      "name": "noPendingChange",
      "msg": "No change is waiting"
    },
    {
      "code": 6030,
      "name": "changeNotDue",
      "msg": "The change is still waiting out its activation delay"
    },
    {
      "code": 6031,
      "name": "notGuardian",
      "msg": "Only the admin or the guardian can do this"
    },
    {
      "code": 6032,
      "name": "shareMintNotCollateral",
      "msg": "Share tokens of this pool can never be collateral"
    },
    {
      "code": 6033,
      "name": "notYetActive",
      "msg": "This collateral is still in its activation delay"
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
          },
          {
            "name": "activeAt",
            "docs": [
              "Backs new debt only from here, so juniors can leave before a new listing adds risk"
            ],
            "type": "i64"
          },
          {
            "name": "pending",
            "docs": [
              "Looser parameters waiting out the activation delay, live from `pending_at`, which is 0 when nothing waits"
            ],
            "type": {
              "defined": {
                "name": "assetParams"
              }
            }
          },
          {
            "name": "pendingAt",
            "type": "i64"
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
          },
          {
            "name": "coveredByJunior",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "changeApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "target",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "changeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "target",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "changeQueued",
      "docs": [
        "A change to the pool, an asset or an LP market, named by `target`, waits until `effective_at`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "target",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
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
      "name": "juniorExit",
      "docs": [
        "A junior lender's shares in the exit queue, held in the pool's escrow until claimed or cancelled",
        "They stay junior money until then: they keep earning and keep taking losses"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "value",
            "docs": [
              "What the shares were worth when queued, the most the exit can pay"
            ],
            "type": "u64"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          },
          {
            "name": "windowSecs",
            "docs": [
              "Terms fixed when the exit was queued, so later parameter changes can only improve them"
            ],
            "type": "u32"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "juniorExitCancelled",
      "docs": [
        "`returned` of the queued `shares` went back to the owner, the rest were burned with the yield earned while queued"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "returned",
            "type": "u64"
          },
          {
            "name": "lapsed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "juniorExitClaimed",
      "docs": [
        "`paid` is USDC, or its worth in senior shares when `in_usdc` is false, after the `fee` left with junior lenders"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "value",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "paid",
            "type": "u64"
          },
          {
            "name": "inUsdc",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "juniorExitRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "value",
            "docs": [
              "The most the exit can pay, before its fee"
            ],
            "type": "u64"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "juniorExitsPaused",
      "docs": [
        "Junior exits are frozen until `until`, which is the present when a pause is lifted"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "until",
            "type": "i64"
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
          },
          {
            "name": "junior",
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
          },
          {
            "name": "activeAt",
            "docs": [
              "Backs new debt only from here, so juniors can leave before a new listing adds risk"
            ],
            "type": "i64"
          },
          {
            "name": "pendingLiqCostBps",
            "docs": [
              "A lower liquidation cost or an unpause waiting out the activation delay, live from `pending_at` when that is not 0"
            ],
            "type": "u16"
          },
          {
            "name": "pendingPaused",
            "type": "bool"
          },
          {
            "name": "pendingAt",
            "type": "i64"
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
            "name": "juniorMint",
            "docs": [
              "Share mint of the junior tranche, unset until the admin opens it"
            ],
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "docs": [
              "May only tighten risk: pause collateral and drop waiting changes, never pause junior exits"
            ],
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
            "name": "usdcGroup",
            "docs": [
              "Shock group of the USDC asset, applied to the USDC side of LP positions as well"
            ],
            "type": "u8"
          },
          {
            "name": "juniorAssets",
            "docs": [
              "Part of the lender assets that belongs to junior lenders, who absorb losses before senior ones"
            ],
            "type": "u64"
          },
          {
            "name": "dust",
            "docs": [
              "Fractions of a base unit still owed to reserves, protocol fees and junior lenders"
            ],
            "type": {
              "array": [
                "u32",
                3
              ]
            }
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
          },
          {
            "name": "juniorQueued",
            "docs": [
              "Junior shares waiting in the exit queue"
            ],
            "type": "u64"
          },
          {
            "name": "juniorPauseStart",
            "docs": [
              "The latest governance pause of junior exits, from start until end"
            ],
            "type": "i64"
          },
          {
            "name": "juniorPauseEnd",
            "type": "i64"
          },
          {
            "name": "juniorNextPauseAt",
            "docs": [
              "Earliest start of the next pause, fixed when a pause starts or is lifted so a later cut to the gap cannot bring it forward"
            ],
            "type": "i64"
          },
          {
            "name": "pendingParams",
            "docs": [
              "Looser parameters waiting out the activation delay, live from `pending_at`, which is 0 when nothing waits"
            ],
            "type": {
              "defined": {
                "name": "poolParams"
              }
            }
          },
          {
            "name": "pendingAt",
            "type": "i64"
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
            "name": "protectionFeeBps",
            "docs": [
              "Share of the senior lenders' interest paid to junior lenders for taking losses first"
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
          },
          {
            "name": "juniorTargetBps",
            "docs": [
              "Junior share of lender assets at which junior lenders earn the whole protection fee and premium"
            ],
            "type": "u16"
          },
          {
            "name": "juniorPremiumBps",
            "docs": [
              "Share of all borrower interest paid to junior lenders on top of their own share, for taking losses first"
            ],
            "type": "u16"
          },
          {
            "name": "juniorMinDelaySecs",
            "docs": [
              "Wait before a queued junior exit can be claimed, from the min with an empty queue up to the max"
            ],
            "type": "u32"
          },
          {
            "name": "juniorMaxDelaySecs",
            "type": "u32"
          },
          {
            "name": "juniorDelayThresholdBps",
            "docs": [
              "Queued share of the junior supply at which the wait reaches its max"
            ],
            "type": "u16"
          },
          {
            "name": "juniorExitWindowSecs",
            "docs": [
              "Time after the wait in which an exit must be claimed, or it lapses and the shares go back to work",
              "Between MIN_JUNIOR_EXIT_WINDOW_SECS and MAX_JUNIOR_EXIT_WINDOW_SECS"
            ],
            "type": "u32"
          },
          {
            "name": "juniorExitFeeBps",
            "docs": [
              "Taken from a junior claim and left with the junior lenders who stay"
            ],
            "type": "u16"
          },
          {
            "name": "juniorMaxPauseSecs",
            "docs": [
              "Longest governance pause of junior exits, never above MAX_JUNIOR_PAUSE_SECS"
            ],
            "type": "u32"
          },
          {
            "name": "juniorPauseGapSecs",
            "docs": [
              "Unpaused time required between two pauses: at least the longest wait plus MAX_JUNIOR_EXIT_WINDOW_SECS,",
              "and at least the activation delay"
            ],
            "type": "u32"
          },
          {
            "name": "activationDelaySecs",
            "docs": [
              "Wait before new collateral, or any change that is not a pure tightening, takes effect",
              "At least the longest junior wait plus the claim window, so juniors who disagree can leave first"
            ],
            "type": "u32"
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
    },
    {
      "name": "trancheConverted",
      "docs": [
        "Senior shares turned into junior shares, `value` USDC moving between the tranches"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lender",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "value",
            "type": "u64"
          },
          {
            "name": "minted",
            "type": "u64"
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
      "name": "juniorEscrowSeed",
      "type": "bytes",
      "value": "[106, 117, 110, 105, 111, 114, 95, 101, 115, 99, 114, 111, 119]"
    },
    {
      "name": "juniorExitSeed",
      "type": "bytes",
      "value": "[106, 117, 110, 105, 111, 114, 95, 101, 120, 105, 116]"
    },
    {
      "name": "juniorMintSeed",
      "type": "bytes",
      "value": "[106, 117, 110, 105, 111, 114, 95, 109, 105, 110, 116]"
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
