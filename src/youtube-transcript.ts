import { requestUrl } from "obsidian";
import {
	parseTranscriptXml,
	parseTranscriptJson3,
	parseTranscript,
	getCaptionTracksFromPage,
	extractVideoTitle,
	extractTranscriptParams,
	extractVisitorData,
	extractPoToken,
	extractPoTokenFromPage,
	generateTranscriptParams,
} from "./api-parser";
import type { TranscriptConfig, TranscriptResponse } from "./types";
import { YoutubeTranscriptError } from "./types";

export { YoutubeTranscriptError } from "./types";
export type {
	TranscriptConfig,
	TranscriptLine,
	TranscriptResponse,
} from "./types";

/**
 * YouTube transcript fetcher using InnerTube Player API.
 * This implementation is based on the approach used by youtube-transcript-api (Python)
 * and obsidian-yt-video-summarizer.
 */
export class YoutubeTranscript {
	// YouTube's public InnerTube API key
	private static readonly INNERTUBE_API_KEY =
		"AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
	private static readonly INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${YoutubeTranscript.INNERTUBE_API_KEY}`;

	// ANDROID client context (matches youtube-transcript-api v1.2.3)
	private static readonly ANDROID_CONTEXT = {
		client: {
			clientName: "ANDROID",
			clientVersion: "20.10.38",
			androidSdkVersion: 30,
			hl: "en",
			gl: "US",
		},
	};

	// WEB client context used as fallback
	private static readonly WEB_CONTEXT = {
		client: {
			clientName: "WEB",
			clientVersion: "2.20240313.00.00",
			hl: "en",
			gl: "US",
		},
	};

	// Player params to bypass ANDROID client integrity checks (NewPipe workaround)
	private static readonly ANDROID_PLAYER_PARAMS = "CgIQBg";

	// Store watch page HTML, cookies, and PO token for reuse between methods
	private static lastWatchPageHtml: string = "";
	private static lastWatchPageCookies: string = "";
	private static lastPoToken: string = "";

	public static async getTranscript(
		url: string,
		config?: TranscriptConfig,
	): Promise<TranscriptResponse> {
		try {
			// Extract video ID from URL
			const videoId = this.extractVideoIdFromUrl(url);
			if (!videoId) {
				throw new YoutubeTranscriptError(
					new Error(
						"Invalid YouTube URL - could not extract video ID",
					),
				);
			}

			console.log(`🎬 Fetching transcript for video: ${videoId}`);

			// Strategy 1: Try caption track URLs (timedtext API)
			try {
				const result = await this.fetchViaTimedText(videoId, config);
				if (result) return result;
			} catch (timedTextError: any) {
				console.log(
					`⚠️ Timedtext approach failed: ${timedTextError.message}`,
				);
			}

			// Strategy 2: Try get_transcript endpoint (protobuf params)
			console.log(
				`🔄 Trying get_transcript endpoint as fallback...`,
			);
			try {
				const result = await this.fetchViaGetTranscript(
					videoId,
					config,
				);
				if (result) return result;
			} catch (getTranscriptError: any) {
				console.log(
					`⚠️ get_transcript approach failed: ${getTranscriptError.message}`,
				);
			}

			throw new YoutubeTranscriptError(
				new Error(
					"All transcript fetching methods failed. The video may not have captions available.",
				),
			);
		} catch (err: any) {
			if (err instanceof YoutubeTranscriptError) {
				throw err;
			}
			throw new YoutubeTranscriptError(err);
		}
	}

	/**
	 * Strategy 1: Fetch transcript via timedtext caption URLs.
	 */
	private static async fetchViaTimedText(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<TranscriptResponse | null> {
		// Fetch player data, trying watch page first, then InnerTube
		const playerData = await this.fetchPlayerDataWithFallback(
			videoId,
			config,
		);

		// Extract video metadata
		const title = playerData.videoDetails?.title || "Unknown";

		// Get caption tracks
		const captionsData =
			playerData.captions?.playerCaptionsTracklistRenderer;
		if (!captionsData || !captionsData.captionTracks) {
			throw new Error("No captions available for this video");
		}

		console.log(
			`📝 Found ${captionsData.captionTracks.length} caption track(s)`,
		);

		// Find the best matching caption track
		const langCode = config?.lang || "en";
		const captionTrack = this.findCaptionTrack(
			captionsData.captionTracks,
			langCode,
		);
		if (!captionTrack) {
			const availableLangs = captionsData.captionTracks
				.map((t: any) => t.languageCode)
				.join(", ");
			throw new Error(
				`No transcript found for language '${langCode}'. Available: ${availableLangs}`,
			);
		}

		const trackName =
			captionTrack.name?.runs?.[0]?.text ||
			captionTrack.name?.simpleText ||
			captionTrack.languageCode;
		console.log(
			`🔄 Using caption track: ${trackName} (${captionTrack.languageCode})`,
		);

		// Fetch the actual transcript from the caption URL
		const transcriptUrl = captionTrack.baseUrl;
		console.log(
			`📥 Fetching transcript from: ${transcriptUrl.substring(0, 80)}...`,
		);

		const lines = await this.fetchTranscriptFromUrl(transcriptUrl);

		if (lines.length === 0) {
			throw new Error(
				"Transcript response contained no parseable caption lines",
			);
		}

		console.log(
			`✅ Successfully fetched ${lines.length} transcript lines`,
		);

		return {
			title: this.decodeHTML(title),
			lines,
		};
	}

	/**
	 * Strategy 2: Fetch transcript via YouTube's get_transcript endpoint.
	 * Uses protobuf-encoded params extracted from the page or generated.
	 */
	private static async fetchViaGetTranscript(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<TranscriptResponse | null> {
		const langCode = config?.lang || "en";

		// Get watch page HTML (may already be cached from strategy 1)
		let html = this.lastWatchPageHtml;
		if (!html) {
			const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
			console.log(`🌐 Fetching watch page for get_transcript: ${watchUrl}`);
			const response = await requestUrl({
				url: watchUrl,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
					"Accept-Language": `${langCode},en;q=0.9`,
					Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{};",
				},
			});
			html = response.text;
		}

		// Extract title
		const titleMatch = html.match(
			/<meta\s+name="title"\s+content="([^"]*)\">/,
		);
		const title = titleMatch ? titleMatch[1] : "Unknown";

		// Extract visitorData for authentication
		const visitorData =
			extractVisitorData(html) ||
			"Cgs5LXVQa0I1YnhHOCjZ7ZDDBjInCgJQTBIhEh0SGwsMDg8QERITFBUWFxgZGhscHR4fICEiIyQlJiAS";

		// Build list of params to try: page params first, then generated fallbacks
		const paramsList: string[] = [];
		const pageParams = extractTranscriptParams(html);
		if (pageParams) {
			console.log(
				`✅ Found transcript params from page (${pageParams.length} chars)`,
			);
			paramsList.push(pageParams);
		}
		const generatedParams = generateTranscriptParams(videoId, langCode);
		paramsList.push(...generatedParams);

		console.log(
			`🔄 Trying ${paramsList.length} param combinations with get_transcript API...`,
		);

		const clientVersion = "2.20250701.01.00";
		const sessionCookies =
			this.lastWatchPageCookies ||
			"CONSENT=YES+cb.20210328-17-p0.en+FX+{}";

		// Try two API URL variations: without API key first (like youtube-transcript-api), then with
		const apiUrlVariations = [
			{ url: "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false", label: "no-key" },
			{ url: `https://www.youtube.com/youtubei/v1/get_transcript?key=${YoutubeTranscript.INNERTUBE_API_KEY}&prettyPrint=false`, label: "with-key" },
		];

		for (const { url: apiUrl, label: apiLabel } of apiUrlVariations) {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "*/*",
				"Accept-Language": "en-US,en;q=0.9",
				"X-Youtube-Client-Name": "1",
				"X-Youtube-Client-Version": clientVersion,
				"X-Goog-Visitor-Id": visitorData,
				Origin: "https://www.youtube.com",
				Referer: `https://www.youtube.com/watch?v=${videoId}`,
				Cookie: sessionCookies,
			};

			for (let i = 0; i < paramsList.length; i++) {
				const params = paramsList[i];
				const source = `${apiLabel}/${i === 0 && pageParams ? "page" : `gen-${i}`}`;

				try {
					console.log(
						`🎯 Attempt (${source}): ${params.substring(0, 30)}...`,
					);

					const requestBody = {
						context: {
							client: {
								clientName: "WEB",
								clientVersion: clientVersion,
								hl: langCode,
								gl: config?.country || "US",
								visitorData: visitorData,
								mainAppWebInfo: {
									graftUrl: `https://www.youtube.com/watch?v=${videoId}`,
									webDisplayMode: "WEB_DISPLAY_MODE_BROWSER",
								},
							},
							user: {
								lockedSafetyMode: false,
							},
							request: {
								useSsl: true,
								internalExperimentFlags: [],
								consistencyTokenJars: [],
							},
						},
						params: params,
					};

					const response = await requestUrl({
						url: apiUrl,
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
						throw: false,
					});

					console.log(
						`📄 get_transcript (${source}): status=${response.status}, ${response.text.length} bytes`,
					);

					if (response.status >= 400) {
						console.log(
							`❌ (${source}): HTTP ${response.status}, body: ${response.text.substring(0, 300)}`,
						);
						continue;
					}

					const lines = parseTranscript(response.text);
					if (lines && lines.length > 0) {
						console.log(
							`✅ SUCCESS: Found ${lines.length} lines via get_transcript (${source})`,
						);
						return {
							title: this.decodeHTML(title),
							lines,
						};
					}

					console.log(
						`⚠️ (${source}): response parsed but 0 lines. Preview: ${response.text.substring(0, 200)}`,
					);
				} catch (e: any) {
					let errorDetail = e.message || String(e);
					try {
						if (e.response) {
							const errText =
								typeof e.response === "string"
									? e.response
									: JSON.stringify(e.response).substring(0, 300);
							errorDetail += ` | response: ${errText}`;
						}
						if (e.body) errorDetail += ` | body: ${String(e.body).substring(0, 300)}`;
						if (e.text) errorDetail += ` | text: ${String(e.text).substring(0, 300)}`;
					} catch {}
					console.log(
						`❌ (${source}) failed: ${errorDetail}`,
					);
				}
			}
		}

		throw new Error(
			"All get_transcript parameter combinations failed",
		);
	}

	/**
	 * Extract video ID from various YouTube URL formats
	 */
	private static extractVideoIdFromUrl(url: string): string | null {
		const patterns = [
			/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
			/^([a-zA-Z0-9_-]{11})$/, // Just the video ID
		];

		for (const pattern of patterns) {
			const match = url.match(pattern);
			if (match) {
				return match[1];
			}
		}
		return null;
	}

	/**
	 * Tries ANDROID client first (no PO token needed), then watch page, then WEB client.
	 * ANDROID InnerTube client returns caption URLs that work without PO tokens,
	 * unlike WEB/watch page URLs which require pot= parameter since May 2025.
	 */
	private static async fetchPlayerDataWithFallback(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<any> {
		// Try ANDROID InnerTube client first (caption URLs don't require PO token)
		try {
			console.log(`📱 Trying ANDROID client first (no PO token needed)...`);
			const data = await this.fetchPlayerData(videoId, "ANDROID", config);
			// Also fetch watch page in parallel for get_transcript fallback data
			this.prefetchWatchPage(videoId, config).catch(() => {});
			return data;
		} catch (androidError: any) {
			console.log(
				`⚠️ ANDROID client failed: ${androidError.message}. Trying watch page...`,
			);
		}

		// Fall back to watch page scraping (may need PO token for timedtext)
		try {
			return await this.fetchPlayerDataFromWatchPage(videoId, config);
		} catch (watchPageError: any) {
			console.log(
				`⚠️ Watch page scraping failed: ${watchPageError.message}. Trying WEB client...`,
			);
		}

		// Last resort: WEB InnerTube client
		try {
			return await this.fetchPlayerData(videoId, "WEB", config);
		} catch (webError: any) {
			throw new Error(
				"All player data sources failed (ANDROID, watch page, WEB)",
			);
		}
	}

	/**
	 * Prefetch watch page HTML in background for get_transcript fallback.
	 * This caches the HTML, cookies, and PO token without blocking the main flow.
	 */
	private static async prefetchWatchPage(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<void> {
		if (this.lastWatchPageHtml) return; // Already cached
		try {
			const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
			const langCode = config?.lang || "en";
			const response = await requestUrl({
				url: watchUrl,
				method: "GET",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
					"Accept-Language": `${langCode},en;q=0.9`,
					Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{};",
				},
			});
			const html = response.text;
			if (html && html.length > 0) {
				this.lastWatchPageHtml = html;
				// Extract cookies
				const setCookies = response.headers["set-cookie"] || "";
				const cookieParts = setCookies
					.split(/,(?=[^ ])/g)
					.map((c: string) => c.split(";")[0].trim())
					.filter((c: string) => c.length > 0);
				cookieParts.push("CONSENT=YES+cb.20210328-17-p0.en+FX+{}");
				this.lastWatchPageCookies = cookieParts.join("; ");
				// Extract PO token
				const poToken = extractPoTokenFromPage(html);
				if (poToken) this.lastPoToken = poToken;
				console.log(`📋 Watch page prefetched (${html.length} bytes, PO token: ${poToken ? "found" : "not found"})`);
			}
		} catch (e: any) {
			console.log(`⚠️ Watch page prefetch failed: ${e.message}`);
		}
	}

	/**
	 * Fetches player data by scraping the YouTube watch page HTML.
	 * Extracts ytInitialPlayerResponse to get caption track URLs.
	 */
	private static async fetchPlayerDataFromWatchPage(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<any> {
		const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
		const langCode = config?.lang || "en";

		console.log(`🌐 Fetching watch page: ${watchUrl}`);

		const response = await requestUrl({
			url: watchUrl,
			method: "GET",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				"Accept-Language": `${langCode},en;q=0.9`,
				// CONSENT cookie bypasses YouTube's GDPR consent page
				Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{};",
			},
		});

		const html = response.text;
		if (!html || html.length === 0) {
			throw new Error("Empty response from YouTube watch page");
		}

		// Extract and cache cookies from response for subsequent requests
		const setCookies = response.headers["set-cookie"] || "";
		const cookieParts = setCookies
			.split(/,(?=[^ ])/g)
			.map((c: string) => c.split(";")[0].trim())
			.filter((c: string) => c.length > 0);
		// Merge with our CONSENT cookie
		cookieParts.push("CONSENT=YES+cb.20210328-17-p0.en+FX+{}");
		this.lastWatchPageCookies = cookieParts.join("; ");
		console.log(
			`🍪 Extracted cookies: ${this.lastWatchPageCookies.substring(0, 150)}...`,
		);

		// Cache for potential reuse by get_transcript fallback
		this.lastWatchPageHtml = html;

		// Extract and cache PO token (required for timedtext since ~May 2025)
		const poToken = extractPoTokenFromPage(html);
		if (poToken) {
			this.lastPoToken = poToken;
			console.log(`🔑 Extracted PO token from watch page (${poToken.length} chars): ${poToken.substring(0, 30)}...`);
		} else {
			console.log(`⚠️ No PO token found in watch page HTML`);
		}

		console.log(
			`📄 Watch page response: ${html.length} bytes`,
		);

		// Try to extract ytInitialPlayerResponse directly
		const playerResponseMatch = html.match(
			/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
		);

		if (playerResponseMatch) {
			try {
				let playerData;
				try {
					playerData = JSON.parse(playerResponseMatch[1]);
				} catch {
					// If initial parse fails, try brace-matching
					playerData = this.extractJsonFromHtml(
						html,
						"ytInitialPlayerResponse",
					);
				}

				if (playerData) {
					// Check playability
					const status = playerData.playabilityStatus?.status;
					if (status === "ERROR") {
						throw new Error(
							playerData.playabilityStatus?.reason ||
								"Video unavailable",
						);
					}
					if (status === "LOGIN_REQUIRED") {
						throw new Error(
							"This video requires login to view",
						);
					}

					if (
						playerData.captions
							?.playerCaptionsTracklistRenderer
							?.captionTracks
					) {
						// Extract title
						if (!playerData.videoDetails?.title) {
							const title = extractVideoTitle(html);
							if (title) {
								playerData.videoDetails =
									playerData.videoDetails || {};
								playerData.videoDetails.title = title;
							}
						}
						console.log(
							`✅ Extracted player data from ytInitialPlayerResponse`,
						);
						return playerData;
					}
				}
			} catch (e: any) {
				if (
					e.message.includes("unavailable") ||
					e.message.includes("login")
				) {
					throw e;
				}
				console.log(
					`⚠️ Failed to parse ytInitialPlayerResponse: ${e.message}`,
				);
			}
		}

		// Fall back to extracting caption tracks from page HTML using api-parser
		const captionTracks = getCaptionTracksFromPage(html, langCode);
		if (captionTracks.length > 0) {
			const title = extractVideoTitle(html) || "Unknown";
			console.log(
				`✅ Extracted ${captionTracks.length} caption tracks from page HTML`,
			);
			// Build a player-data-like structure
			return {
				videoDetails: { title },
				captions: {
					playerCaptionsTracklistRenderer: {
						captionTracks: captionTracks.map((t) => ({
							baseUrl: t.baseUrl,
							name: { simpleText: t.name },
							languageCode: t.languageCode,
							isTranslatable: t.isTranslatable,
						})),
					},
				},
			};
		}

		throw new Error(
			"Could not extract caption data from watch page",
		);
	}

	/**
	 * Extracts a JSON object from HTML by matching braces starting from a variable assignment.
	 */
	private static extractJsonFromHtml(
		html: string,
		varName: string,
	): any {
		const searchStr = `${varName}`;
		const varIdx = html.indexOf(searchStr);
		if (varIdx === -1) return null;

		const startIdx = html.indexOf("{", varIdx);
		if (startIdx === -1) return null;

		let braceCount = 0;
		let endIdx = startIdx;
		for (let i = startIdx; i < html.length; i++) {
			if (html[i] === "{") braceCount++;
			if (html[i] === "}") braceCount--;
			if (braceCount === 0) {
				endIdx = i + 1;
				break;
			}
		}

		return JSON.parse(html.substring(startIdx, endIdx));
	}

	/**
	 * Fetches player data from YouTube's InnerTube API
	 */
	private static async fetchPlayerData(
		videoId: string,
		clientType: "ANDROID" | "WEB",
		config?: TranscriptConfig,
	): Promise<any> {
		const baseContext =
			clientType === "ANDROID"
				? YoutubeTranscript.ANDROID_CONTEXT
				: YoutubeTranscript.WEB_CONTEXT;

		const context = {
			...baseContext,
			client: {
				...baseContext.client,
				hl: config?.lang || "en",
				gl: config?.country || "US",
			},
		};

		const requestBody: Record<string, any> = {
			context: context,
			videoId: videoId,
		};

		// Add player params for ANDROID to bypass integrity checks
		if (clientType === "ANDROID") {
			requestBody.params = YoutubeTranscript.ANDROID_PLAYER_PARAMS;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (clientType === "ANDROID") {
			headers["User-Agent"] =
				"com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
		}

		console.log(
			`🔄 Calling InnerTube Player API with ${clientType} client...`,
		);

		let response;
		try {
			response = await requestUrl({
				url: YoutubeTranscript.INNERTUBE_PLAYER_URL,
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			});
		} catch (err: any) {
			throw new Error(
				`HTTP request failed for ${clientType} client: ${err.message || err}`,
			);
		}

		const data = JSON.parse(response.text);

		// Check playability status
		const playabilityStatus = data.playabilityStatus;
		if (playabilityStatus) {
			console.log(`📊 Playability status: ${playabilityStatus.status}`);

			if (playabilityStatus.status === "ERROR") {
				throw new Error(
					playabilityStatus.reason || "Video unavailable",
				);
			}
			if (playabilityStatus.status === "LOGIN_REQUIRED") {
				throw new Error("This video requires login to view");
			}
			if (playabilityStatus.status === "UNPLAYABLE") {
				throw new Error(
					playabilityStatus.reason || "Video is unplayable",
				);
			}
		}

		// Extract PO token from player response
		const poToken = extractPoToken(data);
		if (poToken) {
			this.lastPoToken = poToken;
			console.log(`🔑 Extracted PO token from ${clientType} player response (${poToken.length} chars)`);
		}

		// Verify captions are present in the response
		if (!data.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
			throw new Error(
				`No captions returned by ${clientType} client`,
			);
		}

		return data;
	}

	/**
	 * Finds the best matching caption track for the requested language
	 */
	private static findCaptionTrack(
		captionTracks: any[],
		langCode: string,
	): any {
		// First try exact match
		let track = captionTracks.find((t: any) => t.languageCode === langCode);
		if (track) return track;

		// Try matching language prefix (e.g., 'en' matches 'en-US')
		track = captionTracks.find((t: any) =>
			t.languageCode.startsWith(langCode + "-"),
		);
		if (track) return track;

		// Try finding track where requested lang is a prefix (e.g., 'en-US' when looking for 'en')
		track = captionTracks.find((t: any) =>
			langCode.startsWith(t.languageCode + "-"),
		);
		if (track) return track;

		// Fall back to first available track
		if (captionTracks.length > 0) {
			console.log(
				`⚠️ Language '${langCode}' not found, falling back to '${captionTracks[0].languageCode}'`,
			);
			return captionTracks[0];
		}

		return null;
	}

	/**
	 * Normalizes a caption track URL: ensures absolute URL, optionally sets format,
	 * and adds PO token if available (required since May 2025).
	 */
	private static normalizeCaptionUrl(
		transcriptUrl: string,
		fmt?: string,
		poToken?: string,
	): string {
		let url = transcriptUrl;
		// Ensure absolute URL (some responses return relative paths)
		if (url.startsWith("/")) {
			url = "https://www.youtube.com" + url;
		}
		if (fmt) {
			// Remove any existing fmt parameter
			url = url.replace(/([?&])fmt=[^&]*(&|$)/, (_, prefix, suffix) =>
				suffix ? prefix : "",
			);
			// Remove trailing & or ?
			url = url.replace(/[?&]$/, "");
			// Add the requested format
			url += (url.includes("?") ? "&" : "?") + `fmt=${fmt}`;
		}
		// Add PO token if available and not already in URL (required since ~May 2025)
		if (poToken && !url.includes("pot=")) {
			url += (url.includes("?") ? "&" : "?") + `pot=${encodeURIComponent(poToken)}&potc=1&c=WEB&cver=2.20250701.01.00`;
		}
		return url;
	}

	/**
	 * Parses a transcript response, auto-detecting the format (JSON3, XML, or srv3 JSON).
	 */
	private static parseTranscriptResponse(responseText: string): any[] {
		const trimmed = responseText.trim();
		if (!trimmed) return [];

		// Detect format by first character
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			// Try JSON3 format
			const json3Lines = parseTranscriptJson3(trimmed);
			if (json3Lines.length > 0) return json3Lines;
		}

		if (trimmed.startsWith("<") || trimmed.includes("<?xml")) {
			// Try XML format
			const xmlLines = parseTranscriptXml(trimmed);
			if (xmlLines.length > 0) return xmlLines;
		}

		// If format detection didn't work, try both parsers
		const json3Lines = parseTranscriptJson3(trimmed);
		if (json3Lines.length > 0) return json3Lines;

		return parseTranscriptXml(trimmed);
	}

	/**
	 * Extracts text from a requestUrl response, handling potential encoding issues.
	 * Falls back to reading arrayBuffer if text is empty.
	 */
	private static extractResponseText(response: any): string {
		// Try text first
		if (response.text && response.text.length > 0) {
			return response.text;
		}
		// Fall back to arrayBuffer (handles gzip/encoding edge cases)
		if (response.arrayBuffer && response.arrayBuffer.byteLength > 0) {
			const decoder = new TextDecoder("utf-8");
			const text = decoder.decode(response.arrayBuffer);
			console.log(
				`🔧 text was empty but arrayBuffer had ${response.arrayBuffer.byteLength} bytes → decoded ${text.length} chars`,
			);
			return text;
		}
		return "";
	}

	/**
	 * Fetches transcript from the caption track URL.
	 * Tries the URL as-is first, then with explicit format parameters.
	 * Adds PO token to URLs if available (required since ~May 2025).
	 */
	private static async fetchTranscriptFromUrl(
		transcriptUrl: string,
	): Promise<any[]> {
		const poToken = this.lastPoToken || "";
		// Use minimal headers (like youtube-transcript-api Python library)
		// ANDROID client caption URLs don't need browser-like headers
		const headers: Record<string, string> = {
			"User-Agent":
				"com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
			"Accept-Language": "en-US,en;q=0.9",
		};

		// Strategy: try the URL as-is first (ANDROID URLs work without PO token),
		// then with PO token if available (for WEB URLs), then format variations
		const urlVariations = [
			// ANDROID client URLs should work as-is without PO token
			{ url: this.normalizeCaptionUrl(transcriptUrl), label: "original" },
			{
				url: this.normalizeCaptionUrl(transcriptUrl, "json3"),
				label: "json3",
			},
			{
				url: this.normalizeCaptionUrl(transcriptUrl, "srv1"),
				label: "srv1 (XML)",
			},
		];

		// If we have a PO token, also try WEB-style URLs with pot= as fallback
		if (poToken) {
			console.log(`🔑 PO token available (${poToken.length} chars) - will try pot= URLs as fallback`);
			urlVariations.push(
				{ url: this.normalizeCaptionUrl(transcriptUrl, undefined, poToken), label: "original+pot" },
				{ url: this.normalizeCaptionUrl(transcriptUrl, "json3", poToken), label: "json3+pot" },
			);
		}

		let lastError: string = "";
		let lastResponsePreview: string = "";

		for (const { url, label } of urlVariations) {
			console.log(
				`📥 Fetching transcript (${label}): ${url.substring(0, 120)}...`,
			);

			try {
				const response = await requestUrl({
					url,
					method: "GET",
					headers,
				});

				// Log response metadata for debugging
				console.log(
					`📊 Response status (${label}): ${response.status}, headers: ${JSON.stringify(response.headers).substring(0, 200)}`,
				);

				const text = this.extractResponseText(response);
				console.log(
					`📄 Response (${label}): text=${text.length} bytes, arrayBuffer=${response.arrayBuffer?.byteLength || 0} bytes, starts with: ${JSON.stringify(text.substring(0, 100))}`,
				);

				if (text.length === 0) {
					lastError = `${label}: empty response (status ${response.status})`;
					continue;
				}

				const lines = this.parseTranscriptResponse(text);
				if (lines.length > 0) {
					console.log(
						`✅ Parsed ${lines.length} lines from ${label} format`,
					);
					return lines;
				}

				lastError = `${label}: response not parseable (${text.length} bytes)`;
				lastResponsePreview = text.substring(0, 200);
			} catch (e: any) {
				lastError = `${label}: ${e.message}`;
				console.log(
					`⚠️ Fetch failed (${label}): ${e.message}, error keys: ${Object.keys(e).join(",")}`,
				);
			}
		}

		throw new Error(
			`Failed to fetch transcript from all URL variations. Last error: ${lastError}${lastResponsePreview ? `. Response preview: ${lastResponsePreview}` : ""}`,
		);
	}

	/**
	 * Decodes HTML entities in a text string
	 */
	private static decodeHTML(text: string): string {
		return text
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&#(\d+);/g, (_, code) =>
				String.fromCharCode(parseInt(code, 10)),
			)
			.replace(/\\n/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}
