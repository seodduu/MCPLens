// MCP stdio server for demos and smoke runs: 12 tools.
// Demo scenario: call only get_weather and leave the other 11 alone, so Lens issues a remove recommendation.
// Registration:  claude mcp add lenstest -- node /path/to/MCPLens-V2/demo/lenstest-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'lenstest', version: '0.2.0' });

const text = (s) => ({ content: [{ type: 'text', text: s }] });

server.tool('get_weather', 'Get current weather conditions for the given city, including temperature, humidity, and sky conditions',
  { query: z.string().describe('City name to look up, e.g. Seoul') },
  async ({ query }) => text(JSON.stringify({ city: query, weather: 'sunny', temp: '31C', humidity: '60%' })));

const fillers = [
  ['get_forecast', 'Get a detailed 7-day weather forecast for the given city with daily high/low temperatures, precipitation probability, wind speed and UV index for outdoor activity planning'],
  ['get_air_quality', 'Get real-time air quality index including PM2.5, PM10, ozone, and nitrogen dioxide levels for the given location with health advisory recommendations'],
  ['search_restaurants', 'Search for restaurants near the given location filtered by cuisine type, price range, rating threshold, and current opening status with detailed review summaries'],
  ['book_reservation', 'Create a restaurant or venue reservation for the specified party size, date, and time slot, handling waitlist placement and cancellation policies automatically'],
  ['translate_text', 'Translate the given text between any supported language pair while preserving tone, idioms, formatting, and domain-specific terminology'],
  ['summarize_url', 'Fetch the given URL and produce a structured summary including key points, entities mentioned, sentiment, and estimated reading time of the original content'],
  ['convert_currency', 'Convert an amount between two currencies using latest exchange rates with historical rate charts and fee-adjusted effective rate calculations'],
  ['track_flight', 'Track live flight status by flight number including departure/arrival times, gate assignments, delay predictions, and aircraft position updates'],
  ['stock_quote', 'Get real-time stock quote with price, volume, market cap, PE ratio, 52-week range, and analyst consensus ratings for the given ticker symbol'],
  ['create_calendar_event', 'Create a calendar event with title, time range, attendees, location, recurrence rules, reminders, and video conference link generation'],
  ['send_notification', 'Send a push notification to the configured device group with title, body, priority level, action buttons, and delivery receipt tracking'],
];
for (const [name, description] of fillers) {
  server.tool(name, description, { input: z.string().describe('Input payload for the operation') },
    async () => text('ok'));
}

await server.connect(new StdioServerTransport());
