{
	"targets": [
		{
		  	"target_name": "mtp",
			"includes": [
				"auto.gypi"
			],
			"sources": [
				"mtp-kernel/native/mtp.cc"
			],
			"conditions" : [
				['OS=="win"', {
					"include_dirs+": [
						"mtp-kernel/native/inc"
					],
					"libraries": [
						"../native/lib/libmtp-9.lib"
					]
				}],
				['OS!="win"', {
					"libraries": [
						"<!@(pkg-config libmtp --libs)"
                    ]
				}]
			]
		},
		{
		  "target_name": "action_after_build",
		  "type": "none",
		  "copies": [
			{
			  "files": [ "<(PRODUCT_DIR)/nbind.node" ],
			  "destination": "resources/mac/native-addons/mtp"
			}
		  ]
		}
	],
	"includes": [
		"auto-top.gypi"
	]
}
