#!/usr/bin/env node
// Test script to debug YouTube transcript fetching
// Usage: node test-fetch.mjs https://youtu.be/fNSbb-Fjhd8

const videoUrl = process.argv[2] || "https://youtu.be/fNSbb-Fjhd8";

// Extract video ID
const match = videoUrl.match(
	/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
);
if (!match) {
	console.error("Invalid YouTube URL");
	process.exit(1);
}
const videoId = match[1];
console.log(`\n🎬 Video ID: ${videoId}\n`);

// ===== Step 1: Fetch watch page =====
console.log("=== Step 1: Fetch watch page ===");
const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
	headers: {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"Accept-Language": "en,en-US;q=0.9",
		Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{}",
	},
	redirect: "follow",
});

console.log(`Status: ${watchRes.status}`);
const setCookieHeaders = watchRes.headers.getSetCookie?.() || [];
console.log(`Set-Cookie count: ${setCookieHeaders.length}`);
const cookies = setCookieHeaders
	.map((c) => c.split(";")[0])
	.concat(["CONSENT=YES+cb.20210328-17-p0.en+FX+{}"])
	.join("; ");
console.log(`Cookies: ${cookies.substring(0, 200)}...\n`);

const html = await watchRes.text();
console.log(`HTML size: ${html.length} bytes`);

// Check for ytInitialPlayerResponse
const playerMatch = html.match(
	/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
);
if (playerMatch) {
	try {
		const playerData = JSON.parse(playerMatch[1]);
		const captions =
			playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
		if (captions) {
			console.log(`\n📝 Caption tracks: ${captions.length}`);
			for (const track of captions) {
				console.log(
					`  - ${track.languageCode}: ${track.name?.simpleText || track.name?.runs?.[0]?.text || "?"}`,
				);
				console.log(`    URL: ${track.baseUrl.substring(0, 100)}...`);
			}

			// ===== Step 2: Fetch timedtext =====
			console.log("\n=== Step 2: Fetch timedtext (with cookies) ===");
			const captionUrl = captions[0].baseUrl;

			for (const fmt of ["(original)", "json3", "srv1"]) {
				let url = captionUrl;
				if (fmt !== "(original)") {
					url = url.replace(/([?&])fmt=[^&]*(&|$)/, "$1");
					url = url.replace(/[?&]$/, "");
					url += (url.includes("?") ? "&" : "?") + `fmt=${fmt}`;
				}

				console.log(`\n📥 Trying ${fmt}:`);

				// Without cookies
				const res1 = await fetch(url, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						"Accept-Encoding": "identity",
					},
				});
				const body1 = await res1.text();
				console.log(
					`  WITHOUT cookies: status=${res1.status}, content-length=${res1.headers.get("content-length")}, body=${body1.length} bytes`,
				);
				if (body1.length > 0)
					console.log(`  Preview: ${body1.substring(0, 100)}`);

				// With cookies
				const res2 = await fetch(url, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						"Accept-Encoding": "identity",
						Cookie: cookies,
					},
				});
				const body2 = await res2.text();
				console.log(
					`  WITH cookies:    status=${res2.status}, content-length=${res2.headers.get("content-length")}, body=${body2.length} bytes`,
				);
				if (body2.length > 0)
					console.log(`  Preview: ${body2.substring(0, 100)}`);

				if (body2.length > 0) break; // Found working format
			}
		} else {
			console.log("❌ No caption tracks in ytInitialPlayerResponse");
		}
	} catch (e) {
		console.log(`❌ Failed to parse ytInitialPlayerResponse: ${e.message}`);
	}
} else {
	console.log("❌ ytInitialPlayerResponse not found in HTML");
}

// ===== Step 3: Test get_transcript =====
console.log("\n=== Step 3: Test get_transcript ===");

// Extract params from ytInitialData
let pageParams = null;
const dataPatterns = [
	/var ytInitialData\s*=\s*(\{.+?\});/s,
	/ytInitialData\s*=\s*({.+?});/s,
];
for (const pattern of dataPatterns) {
	const m = html.match(pattern);
	if (m) {
		try {
			// Brace matching
			const startIdx = html.indexOf(m[0]);
			const searchStart = html.indexOf("{", startIdx);
			let braceCount = 0;
			let endIdx = searchStart;
			for (let i = searchStart; i < html.length; i++) {
				if (html[i] === "{") braceCount++;
				if (html[i] === "}") braceCount--;
				if (braceCount === 0) {
					endIdx = i + 1;
					break;
				}
			}
			const data = JSON.parse(html.substring(searchStart, endIdx));

			// Recursive search for getTranscriptEndpoint.params
			function findParams(obj, depth = 0) {
				if (!obj || typeof obj !== "object" || depth > 20) return null;
				if (obj.getTranscriptEndpoint?.params)
					return obj.getTranscriptEndpoint.params;
				for (const val of Object.values(obj)) {
					const r = findParams(val, depth + 1);
					if (r) return r;
				}
				return null;
			}
			pageParams = findParams(data);
			if (pageParams) {
				console.log(
					`✅ Page params: ${pageParams.substring(0, 50)}... (${pageParams.length} chars)`,
				);
				break;
			}
		} catch {}
	}
}

if (!pageParams) {
	console.log("❌ No page params found");
}

// Extract visitorData
const visitorMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
const visitorData = visitorMatch ? visitorMatch[1] : "fallback";
console.log(`visitorData: ${visitorData.substring(0, 30)}...`);

// Try get_transcript with page params
if (pageParams) {
	const apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
	const apiUrl = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`;

	const body = JSON.stringify({
		context: {
			client: {
				clientName: "WEB",
				clientVersion: "2.20250701.01.00",
				hl: "en",
				gl: "US",
				mainAppWebInfo: {
					graftUrl: `https://www.youtube.com/watch?v=${videoId}`,
					webDisplayMode: "WEB_DISPLAY_MODE_BROWSER",
				},
			},
			user: { lockedSafetyMode: false },
			request: {
				useSsl: true,
				internalExperimentFlags: [],
				consistencyTokenJars: [],
			},
		},
		externalVideoId: videoId,
		params: pageParams,
	});

	console.log(`\n📥 Calling get_transcript with page params...`);

	// Without cookies
	const res1 = await fetch(apiUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0",
			"X-Youtube-Client-Name": "1",
			"X-Youtube-Client-Version": "2.20250701.01.00",
			"X-Goog-EOM-Visitor-Id": visitorData,
			Origin: "https://www.youtube.com",
			Referer: `https://www.youtube.com/watch?v=${videoId}`,
		},
		body,
	});
	const text1 = await res1.text();
	console.log(
		`  WITHOUT cookies: status=${res1.status}, body=${text1.length} bytes`,
	);
	if (text1.length > 0 && text1.length < 500)
		console.log(`  Body: ${text1}`);
	else if (text1.length > 0)
		console.log(`  Preview: ${text1.substring(0, 200)}`);

	// With cookies
	const res2 = await fetch(apiUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0",
			"X-Youtube-Client-Name": "1",
			"X-Youtube-Client-Version": "2.20250701.01.00",
			"X-Goog-EOM-Visitor-Id": visitorData,
			Origin: "https://www.youtube.com",
			Referer: `https://www.youtube.com/watch?v=${videoId}`,
			Cookie: cookies,
		},
		body,
	});
	const text2 = await res2.text();
	console.log(
		`  WITH cookies:    status=${res2.status}, body=${text2.length} bytes`,
	);
	if (text2.length > 0 && text2.length < 500)
		console.log(`  Body: ${text2}`);
	else if (text2.length > 0)
		console.log(`  Preview: ${text2.substring(0, 200)}`);
}

console.log("\n✅ Test complete");
