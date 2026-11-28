# Cloudflare Workers or Google Cloud Run? Choosing Where an MCP App Runs

[TypeScript and Workers by Default](why-typescript-and-workers.md) compares Workers with containers in general. This page compares Workers with the strongest container alternative for MCP apps: **Google Cloud Run**. Cloud Run already solves most of the problems people associate with containers. It scales automatically and to zero, runs on fully managed infrastructure, can bill per request, and can deploy straight from source code without a Dockerfile. So the case for Workers is closer than it first looks, and an FDE should know both.

**Our summary:** Workers are optimized for lightweight, connector-native MCP apps, which is what this bootcamp builds. Cloud Run is optimized for general-purpose AI and agentic applications. Both are good choices.

## Start here: Cloudflare needs no credit card

Cloudflare's free plan [needs no credit card](https://workers.cloudflare.com/) to sign up, and every step of this bootcamp fits in it. Google Cloud's free trial asks you to [provide a credit card or other payment method](https://cloud.google.com/free/docs/free-cloud-features) when you sign up, and the payment method is verified before you can use it, even if you never go past the free tier. For many students, especially those without an international credit card, that difference decides the question before any architecture does. It is one reason this bootcamp starts on Cloudflare.

## How they differ

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagram-isolates-vs-containers-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="../assets/diagram-isolates-vs-containers-light.png">
  <img src="../assets/diagram-isolates-vs-containers-light.png" alt="Two ways to run the same MCP server, both fully managed and scaling to zero. Cloudflare Workers: Claude and ChatGPT call lightweight V8 isolates in one shared runtime on Cloudflare's global network, each starting fast with 128 MB of memory and billed for CPU time, reaching Neon Postgres. Google Cloud Run: Claude and ChatGPT call a managed container in a region you pick, holding your MCP app in TypeScript or Python, a full Node.js or Python runtime and any system libraries, with memory you choose, billed for CPU and memory while busy, reaching Neon Postgres." width="100%">
</picture>

| | Cloudflare Workers | Google Cloud Run |
| --- | --- | --- |
| What runs your code | V8 isolates | Containers |
| Infrastructure to manage | None: fully managed | None: fully managed |
| Scale to zero, automatic scaling | Yes | Yes |
| Cold starts | Very short | Longer, depending on the app and image |
| Where it runs | Cloudflare's global network by default | The region you choose |
| TypeScript | Excellent | Excellent |
| Python | Restricted (Pyodide) | Full runtime |
| Native libraries | Restricted | Full support |
| Docker knowledge needed | No | No, with source deploys; helpful otherwise |
| Stateless MCP servers | Excellent | Excellent ([documented by Google](https://docs.cloud.google.com/run/docs/host-mcp-servers), Streamable HTTP) |
| Heavy computation | Limited | Excellent |
| Background work | Queues and Workflows | Jobs, worker pools, Pub/Sub, Cloud Tasks |
| GPUs | Separate services | Supported |
| Portability to other hosts | Moderate | High: a container runs almost anywhere |
| Enterprise cloud integration | Good | Excellent within Google Cloud |
| Billing | Requests and CPU time | Requests, plus CPU and memory while busy |
| Sign-up | No credit card for the free plan | Credit card or other payment method |

Hosting MCP is not what separates them: Google documents hosting remote MCP servers with Streamable HTTP on Cloud Run, as Cloudflare does on Workers. The real question is whether your MCP app needs a container's extra flexibility.

## The strongest argument for Workers: the economics of waiting

An MCP tool call mostly waits: for Neon, for another company's API, for a business system. Workers bill for [CPU time](https://developers.cloudflare.com/workers/platform/pricing/), and [waiting on network requests or database queries doesn't count](https://developers.cloudflare.com/workers/platform/limits/). Cloud Run's default request-based billing [charges for the CPU and memory allocated to an instance while at least one request is being processed](https://cloud.google.com/run/pricing), waiting included, rounded up to the nearest 100 ms. Requests running at the same time on one instance share that time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagram-request-billing-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="../assets/diagram-request-billing-light.png">
  <img src="../assets/diagram-request-billing-light.png" alt="An illustrative one-second MCP tool call with 50 ms of CPU work and 950 ms waiting on Neon and another API. On Cloudflare Workers about 50 ms of CPU time is billed, because waiting is not CPU time. On Google Cloud Run with request-based billing, the instance's allocated vCPU and memory are billed for about the whole second. Concurrent requests share an instance's time on Cloud Run, both platforms charge per request and both have free tiers; an app that needs more than 10 ms of CPU per request on Workers Free may still fit Cloud Run's free tier." width="100%">
</picture>

This is the best reason to choose Workers for I/O-heavy MCP apps. It doesn't make Workers cheaper in every case.

| Free allowance | Cloudflare Workers Free | Google Cloud Run (request-based billing) |
| --- | --- | --- |
| Requests | 100,000 a day | 2 million a month |
| Compute | 10 ms of CPU per request | 180,000 vCPU-seconds a month |
| Memory | 128 MB per isolate, not billed separately | 360,000 GiB-seconds a month |
| Paid plan | Workers Paid, $5 a month plus usage | Pay for usage beyond the free tier |
| Data out | No egress or bandwidth charges | Charged beyond a small free tier |

Checked on November 27, 2026, against [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Cloud Run pricing](https://cloud.google.com/run/pricing). Prices change, so check them before you advise a client.

One consequence surprises people: **Cloud Run can be cheaper for some small projects.** A Worker on the free plan gets 10 ms of CPU per request, so an app that needs more must move to Workers Paid, while the same app might fit inside Cloud Run's monthly free compute. Workers pull ahead as traffic grows and as calls spend more of their time waiting.

## Where Cloud Run is the better choice

- **Less lock-in.** A standard container moves between Cloud Run, AWS, Azure, Railway, Kubernetes and your own servers. Cloudflare's bindings, Durable Objects and Workflows are much harder to move. An FDE who serves many clients gains from portability.
- **Fewer runtime limits.** Cloud Run is an ordinary container: any Node.js library, any Python package, Linux binaries, document converters, headless browsers and native dependencies. Workers have [128 MB of memory per isolate and at most 5 minutes of CPU time per request on Workers Paid](https://developers.cloudflare.com/workers/platform/limits/).
- **Broader AI engineering.** Document processing, sandboxed code execution, GPUs and heavy computation all fit Cloud Run more naturally.
- **Companies already on Google Cloud.** Cloud Run sits beside BigQuery, Vertex AI, Cloud Storage, Pub/Sub, IAM and enterprise networking. If a client has standardized on Google Cloud, that is a strong reason to deploy there.

## Where Workers are the better choice

- **No credit card, and free to start.** See above.
- **Global by default.** A Worker runs across Cloudflare's network without configuring regions. With a database in one region that isn't always the fastest choice, so Cloudflare offers [placement](https://developers.cloudflare.com/workers/configuration/placement/) to run a Worker near its backend, just as you would deploy Cloud Run in the database's region.
- **Agent infrastructure in one place.** The pieces an MCP app grows into sit on one platform and bind to the same Worker:

  | Need | Cloudflare | Google Cloud |
  | --- | --- | --- |
  | Serverless execution | Workers | Cloud Run |
  | Per-user or per-company state | Durable Objects | An external store and coordination service |
  | Durable multi-step jobs | Workflows | Google Cloud Workflows |
  | Background messages | Queues | Pub/Sub, Cloud Tasks |
  | Object storage | R2 | Cloud Storage |
  | Models | Workers AI | Vertex AI |
  | Containers when needed | Containers | Cloud Run itself |

  Google's ecosystem is broader; Cloudflare's is more compact.
- **Simpler to learn first.** You learn TypeScript, MCP, sign-in, business logic and Postgres before containers and cloud networking. Cloud Run's source deploys have narrowed that gap, but not closed it.

## How they compare

**These scores are our architectural judgment, not benchmark results.** The overall verdict depends on which criteria matter for the job, so we don't simply average them.

| Criterion | Workers | Cloud Run |
| --- | --- | --- |
| Fit for MCP apps | 9.8 | 9.5 |
| Developer simplicity | 9.5 | 9.0 |
| Cost for I/O-heavy work | 9.7 | 8.5 |
| Portability | 7.5 | 9.8 |
| Runtime flexibility | 7.5 | 10 |
| Global deployment | 10 | 8.0 |
| Agent infrastructure | 9.5 | 9.5 |
| Enterprise versatility | 8.5 | 9.8 |
| Fit for teaching | 9.7 | 9.0 |

- **For lightweight, connector-native MCP apps:** Workers, about 9.5 against Cloud Run's 9.2.
- **For general-purpose AI engineering:** Cloud Run, about 9.6 against Workers' 8.5.

| If the goal is to… | Choose |
| --- | --- |
| Build MCP apps, as in this bootcamp | Workers |
| Launch an inexpensive SaaS product | Workers |
| Build lightweight integrations for AI Workers | Workers |
| Do general-purpose AI engineering | Cloud Run |
| Serve an enterprise already on Google Cloud | Cloud Run |
| Keep lock-in as low as possible | Cloud Run |
| Stay ready for unknown future computing needs | Cloud Run |

## What this means for you

This bootcamp deploys to **Cloudflare Workers**, and every step is written for it. Cloud Run is where to go when a client needs it: their company runs on Google Cloud, their workload needs a container, or portability matters more than cost.

So build **portable by design**. Keep your business logic in plain TypeScript modules that take their inputs as arguments and don't call Cloudflare APIs, keep the data in standard Postgres, and keep Cloudflare bindings at the edges of your code. Then moving a client's app to Cloud Run means rewriting the edges, not the business. The stack's principles become:

**TypeScript-first. MCP-first. Postgres-first. Serverless-first. Portable by design.**

Serverless-first doesn't mean container-free: Cloud Run shows that containers can be serverless too.

---

Back to [TypeScript and Workers by Default](why-typescript-and-workers.md) · [The Agent Factory Stack](agent-factory-stack.md) · [Costs and cleanup](costs-and-cleanup.md)
