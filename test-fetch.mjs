#!/usr/bin/env node
// Test script v4 - PO token extraction and timedtext fix
const videoUrl = process.argv[2] || "https://youtu.be/fNSbb-Fjhd8";
const match = videoUrl.match(
	/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
);
if (!match) { console.error("Invalid YouTube URL"); process.exit(1); }
const videoId = match[1];
console.log(`\n🎬 Video ID: ${videoId}\n`);

// ============================================================
// Step 1: Fetch watch page & extract everything
// ============================================================
console.log("=== Step 1: Fetch watch page ===");
const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
	headers: {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"Accept-Language": "en,en-US;q=0.9",
		Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{}",
	},
	redirect: "follow",
});
console.log(`Watch page status: ${watchRes.status}`);
const cookies = (watchRes.headers.getSetCookie?.() || [])
	.map(c => c.split(";")[0]).concat(["CONSENT=YES+cb.20210328-17-p0.en+FX+{}"]).join("; ");
const html = await watchRes.text();
console.log(`HTML size: ${html.length} bytes`);

// ============================================================
// Step 2: Extract PO token from ytInitialPlayerResponse
// ============================================================
console.log("\n=== Step 2: Extract PO token ===");
const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s);
let captionUrl = null;
let lang = null;
let poToken = null;

if (playerMatch) {
	try {
		const p = JSON.parse(playerMatch[1]);

		// Extract PO token from serviceIntegrityDimensions
		poToken = p?.serviceIntegrityDimensions?.poToken || null;
		if (poToken) {
			console.log(`🔑 PO token found! (${poToken.length} chars): ${poToken.substring(0, 50)}...`);
		} else {
			console.log(`❌ No PO token in serviceIntegrityDimensions`);
			// Log what serviceIntegrityDimensions contains
			const sid = p?.serviceIntegrityDimensions;
			if (sid) {
				console.log(`  serviceIntegrityDimensions keys: ${Object.keys(sid).join(", ")}`);
			} else {
				console.log(`  serviceIntegrityDimensions not present in player response`);
			}
		}

		// Also try regex as fallback
		if (!poToken) {
			const poMatch = html.match(/"serviceIntegrityDimensions"\s*:\s*\{[^}]*"poToken"\s*:\s*"([^"]+)"/);
			if (poMatch) {
				poToken = poMatch[1];
				console.log(`🔑 PO token found via regex! (${poToken.length} chars): ${poToken.substring(0, 50)}...`);
			}
		}

		const captions = p?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
		if (captions && captions.length > 0) {
			const track = captions[0];
			lang = track.languageCode;
			captionUrl = track.baseUrl;
			captionUrl = captionUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)));
			console.log(`📝 Caption track: ${lang} (${track.name?.simpleText || track.name?.runs?.[0]?.text})`);
			console.log(`📎 baseUrl (${captionUrl.length} chars)`);

			// Check if baseUrl already has pot= parameter
			if (captionUrl.includes("pot=")) {
				console.log(`✅ baseUrl already contains pot= parameter`);
			} else {
				console.log(`⚠️ baseUrl does NOT contain pot= parameter`);
			}
		}
	} catch(e) { console.log(`Parse error: ${e.message}`); }
}

// ============================================================
// Step 3: Test timedtext URLs with PO token
// ============================================================
if (captionUrl) {
	console.log("\n=== Step 3: Timedtext URL tests ===");

	// Test A: baseUrl as-is (likely returns empty without pot)
	console.log("\n--- Test A: baseUrl as-is ---");
	const r1 = await fetch(captionUrl, { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookies } });
	const b1 = await r1.text();
	console.log(`status=${r1.status}, body=${b1.length} bytes`);
	if (b1.length > 0 && b1.length < 300) console.log(`Body: ${b1}`);
	if (b1.length > 300) console.log(`Preview: ${b1.substring(0, 200)}`);

	// Test B: baseUrl + pot= parameter
	if (poToken) {
		console.log("\n--- Test B: baseUrl + pot= + c=WEB ---");
		let potUrl = captionUrl;
		if (!potUrl.includes("pot=")) {
			potUrl += `&pot=${encodeURIComponent(poToken)}&potc=1&c=WEB&cver=2.20250701.01.00`;
		}
		console.log(`URL length: ${potUrl.length} chars`);
		const r2 = await fetch(potUrl, { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookies } });
		const b2 = await r2.text();
		console.log(`status=${r2.status}, body=${b2.length} bytes`);
		if (b2.length > 0 && b2.length < 300) console.log(`Body: ${b2}`);
		if (b2.length >= 300) console.log(`Preview: ${b2.substring(0, 200)}`);

		// Test C: fmt=json3 + pot=
		console.log("\n--- Test C: json3 format + pot= ---");
		let json3Url = captionUrl.replace(/([?&])fmt=[^&]*(&|$)/, (_, p, s) => s ? p : "").replace(/[?&]$/, "");
		json3Url += "&fmt=json3";
		if (!json3Url.includes("pot=")) {
			json3Url += `&pot=${encodeURIComponent(poToken)}&potc=1&c=WEB&cver=2.20250701.01.00`;
		}
		const r3 = await fetch(json3Url, { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookies } });
		const b3 = await r3.text();
		console.log(`status=${r3.status}, body=${b3.length} bytes`);
		if (b3.length > 0 && b3.length < 300) console.log(`Body: ${b3}`);
		if (b3.length >= 300) console.log(`Preview: ${b3.substring(0, 200)}`);
	} else {
		console.log("\n⚠️ Skipping PO token tests - no PO token extracted");
	}
}

// ============================================================
// Step 4: get_transcript with visitorData
// ============================================================
console.log("\n=== Step 4: get_transcript ===");
const visitorMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
const visitorData = visitorMatch?.[1] || "";
console.log(`visitorData: ${visitorData ? visitorData.substring(0, 40) + "..." : "NOT FOUND"}`);

let pageParams = null;
for (const pattern of [/var ytInitialData\s*=\s*({.+?});/s, /ytInitialData\s*=\s*({.+?});/s]) {
	const m = html.match(pattern);
	if (!m) continue;
	try {
		const si = html.indexOf(m[0]);
		const ss = html.indexOf("{", si);
		let bc = 0, ei = ss;
		for (let i = ss; i < html.length; i++) {
			if (html[i] === "{") bc++;
			if (html[i] === "}") bc--;
			if (bc === 0) { ei = i + 1; break; }
		}
		const data = JSON.parse(html.substring(ss, ei));
		const find = (obj, d = 0) => {
			if (!obj || typeof obj !== "object" || d > 20) return null;
			if (obj.getTranscriptEndpoint?.params) return obj.getTranscriptEndpoint.params;
			for (const v of Object.values(obj)) { const r = find(v, d+1); if (r) return r; }
			return null;
		};
		pageParams = find(data);
		if (pageParams) break;
	} catch {}
}

console.log(`pageParams: ${pageParams ? `found (${pageParams.length} chars)` : "NOT FOUND"}`);

if (pageParams && visitorData) {
	const clientVersion = "2.20250701.01.00";
	const body = JSON.stringify({
		context: {
			client: {
				clientName: "WEB",
				clientVersion: clientVersion,
				hl: "en", gl: "US",
				visitorData: visitorData,
				mainAppWebInfo: {
					graftUrl: `https://www.youtube.com/watch?v=${videoId}`,
					webDisplayMode: "WEB_DISPLAY_MODE_BROWSER",
				},
			},
			user: { lockedSafetyMode: false },
			request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
		},
		params: pageParams,
	});

	// Test A: Without API key, with X-Goog-Visitor-Id
	console.log("\n--- Test A: No API key, X-Goog-Visitor-Id ---");
	const apiUrl = "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false";
	const r1 = await fetch(apiUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Youtube-Client-Name": "1",
			"X-Youtube-Client-Version": clientVersion,
			"X-Goog-Visitor-Id": visitorData,
			Origin: "https://www.youtube.com",
			Cookie: cookies,
		},
		body,
	});
	const t1 = await r1.text();
	console.log(`status=${r1.status}, body=${t1.length}`);
	if (t1.length < 500) console.log(t1); else console.log(t1.substring(0, 300));

	// Test B: With API key
	console.log("\n--- Test B: With API key ---");
	const r2 = await fetch(apiUrl + "&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Youtube-Client-Name": "1",
			"X-Youtube-Client-Version": clientVersion,
			"X-Goog-Visitor-Id": visitorData,
			Origin: "https://www.youtube.com",
			Cookie: cookies,
		},
		body,
	});
	const t2 = await r2.text();
	console.log(`status=${r2.status}, body=${t2.length}`);
	if (t2.length < 500) console.log(t2); else console.log(t2.substring(0, 300));

	// Test C: Minimal headers (like youtube-transcript-api)
	console.log("\n--- Test C: Minimal headers ---");
	const r3 = await fetch(apiUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookies,
		},
		body,
	});
	const t3 = await r3.text();
	console.log(`status=${r3.status}, body=${t3.length}`);
	if (t3.length < 500) console.log(t3); else console.log(t3.substring(0, 300));
} else {
	console.log(`⚠️ Missing: pageParams=${pageParams ? "found" : "NOT FOUND"}, visitorData=${visitorData ? "found" : "NOT FOUND"}`);
}

// ============================================================
// Step 5: ⭐ ANDROID InnerTube client (KEY TEST - like youtube-transcript-api)
// This is the approach used by youtube-transcript-api Python library.
// ANDROID caption URLs should work WITHOUT PO token.
// ============================================================
console.log("\n=== Step 5: ⭐ ANDROID InnerTube client (KEY TEST) ===");
const androidRes = await fetch(
	"https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
	{
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
		},
		body: JSON.stringify({
			context: {
				client: {
					clientName: "ANDROID",
					clientVersion: "20.10.38",
					androidSdkVersion: 30,
					hl: "en", gl: "US",
				},
			},
			videoId: videoId,
			params: "CgIQBg",
		}),
	},
);
const androidData = JSON.parse(await androidRes.text());
console.log(`ANDROID player status: ${androidData.playabilityStatus?.status}`);

const androidCaptions = androidData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
if (androidCaptions && androidCaptions.length > 0) {
	console.log(`ANDROID caption tracks: ${androidCaptions.length}`);
	for (const t of androidCaptions.slice(0, 3)) {
		let url = t.baseUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
			String.fromCharCode(parseInt(hex, 16)));
		console.log(`\n  ${t.languageCode} (${t.name?.simpleText || t.name?.runs?.[0]?.text || "?"}):`);
		console.log(`    has pot=${url.includes("pot=")} (${url.length} chars)`);

		// Try fetching ANDROID caption URL with minimal headers (like youtube-transcript-api)
		console.log("    --- Fetching with ANDROID user-agent (minimal headers) ---");
		const r = await fetch(url, {
			headers: {
				"User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		const body = await r.text();
		console.log(`    status=${r.status}, body=${body.length} bytes`);
		if (body.length > 0 && body.length < 200) console.log(`    Body: ${body}`);
		if (body.length >= 200) console.log(`    ✅ Preview: ${body.substring(0, 150)}`);

		// If original fails, try json3 format
		if (body.length === 0) {
			console.log("    --- Retrying with fmt=json3 ---");
			const json3Url = url.replace(/([?&])fmt=[^&]*(&|$)/, (_, p, s) => s ? p : "").replace(/[?&]$/, "") + "&fmt=json3";
			const r2 = await fetch(json3Url, {
				headers: {
					"User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
					"Accept-Language": "en-US,en;q=0.9",
				},
			});
			const b2 = await r2.text();
			console.log(`    status=${r2.status}, body=${b2.length} bytes`);
			if (b2.length > 0) console.log(`    ✅ json3 Preview: ${b2.substring(0, 150)}`);
		}
	}
} else {
	console.log(`No ANDROID captions. Status: ${androidData.playabilityStatus?.status}, reason: ${androidData.playabilityStatus?.reason || "none"}`);
	if (androidData.playabilityStatus?.status) {
		console.log(`Full playability: ${JSON.stringify(androidData.playabilityStatus).substring(0, 300)}`);
	}
}

// ============================================================
// Step 6: IOS InnerTube client (additional test)
// ============================================================
console.log("\n=== Step 6: IOS InnerTube client ===");
const iosRes = await fetch(
	"https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			context: {
				client: {
					clientName: "IOS",
					clientVersion: "20.03.02",
					deviceMake: "Apple",
					deviceModel: "iPhone16,2",
					userAgent: "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
					osName: "iPhone",
					osVersion: "18.3.2.22D82",
					hl: "en", gl: "US",
				},
			},
			videoId: videoId,
			contentCheckOk: true,
		}),
	},
);
const iosData = JSON.parse(await iosRes.text());
console.log(`IOS player status: ${iosData.playabilityStatus?.status}`);

// Check for PO token in IOS response
const iosPoToken = iosData?.serviceIntegrityDimensions?.poToken;
if (iosPoToken) {
	console.log(`🔑 IOS PO token: ${iosPoToken.substring(0, 50)}...`);
} else {
	console.log(`❌ No PO token in IOS response`);
}

const iosCaptions = iosData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
if (iosCaptions && iosCaptions.length > 0) {
	console.log(`IOS caption tracks: ${iosCaptions.length}`);
	for (const t of iosCaptions.slice(0, 2)) {
		let url = t.baseUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
			String.fromCharCode(parseInt(hex, 16)));
		console.log(`  ${t.languageCode}: has pot=${url.includes("pot=")} (${url.length} chars)`);

		// Try fetching IOS caption URL
		const r = await fetch(url, { headers: { "User-Agent": "com.google.ios.youtube/20.03.02" } });
		const body = await r.text();
		console.log(`    status=${r.status}, body=${body.length} bytes`);
		if (body.length > 0 && body.length < 200) console.log(`    Body: ${body}`);
		if (body.length >= 200) console.log(`    Preview: ${body.substring(0, 150)}`);

		// If IOS URL also empty, try adding pot from web player
		if (body.length === 0 && poToken && !url.includes("pot=")) {
			console.log("    Retrying IOS URL + web PO token...");
			const potUrl = url + `&pot=${encodeURIComponent(poToken)}&potc=1`;
			const r2 = await fetch(potUrl, { headers: { "User-Agent": "com.google.ios.youtube/20.03.02" } });
			const b2 = await r2.text();
			console.log(`    status=${r2.status}, body=${b2.length} bytes`);
			if (b2.length > 0) console.log(`    Preview: ${b2.substring(0, 150)}`);
		}
	}
} else {
	console.log(`No IOS captions. Status: ${iosData.playabilityStatus?.status}, reason: ${iosData.playabilityStatus?.reason || "none"}`);
}

console.log("\n✅ Test complete");
