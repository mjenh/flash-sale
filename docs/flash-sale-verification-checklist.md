# Flash Sale System — Implementation Verification Checklist

Use this to verify every requirement in `flash-sale-system.md` is implemented. Check each item once verified in code and/or by test.

## 1. Core Functional Requirements

### Flash Sale Period
- [ ] Sale has a **configurable** start time and end time
- [ ] Purchase attempts **before** the start time are rejected (status: upcoming)
- [ ] Purchase attempts **after** the end time are rejected (status: ended)
- [ ] Purchases are only accepted **within** the active window

### Single Product, Limited Stock
- [ ] System sells exactly **one product type**
- [ ] Product has a **predefined, configurable** stock quantity
- [ ] Stock **never goes negative** (no overselling)
- [ ] Sale reports **sold out** once stock reaches zero

### One Item Per User
- [ ] Each user can purchase **at most one** unit
- [ ] Duplicate/repeat purchase attempts by the same user are rejected with a clear "already purchased" result
- [ ] Rule holds under **concurrent** duplicate requests from the same user

### API Server
- [ ] Endpoint to **check sale status** (upcoming / active / ended / sold out)
- [ ] Endpoint for a user to **attempt a purchase**
- [ ] Endpoint for a user to **check if they secured an item**
- [ ] API returns clear, distinct responses for each outcome (success, already purchased, sold out, sale not active)
- [ ] Built with **Node.js** using Express, Fastify, Nest.js, or native `http`

### Simple Frontend
- [ ] Displays the **current sale status**
- [ ] Field to enter a **user identifier** (username/email)
- [ ] **"Buy Now"** button to attempt a purchase
- [ ] Shows feedback: **success**, **already purchased**, and **ended / sold out**
- [ ] Built with **React**

### System Diagram
- [ ] Architecture diagram showing main components and their interactions
- [ ] Diagram included in the `README.md`
- [ ] Design choices are justified in writing

## 2. Non-Functional Requirements

### High Throughput & Scalability
- [ ] Designed to handle a large number of **concurrent requests**
- [ ] Bottlenecks identified and mitigated (e.g., queue, cache, atomic ops)
- [ ] Design can scale horizontally (stateless services / shared store)

### Robustness & Fault Tolerance
- [ ] Handles service crashes / restarts without data corruption
- [ ] Handles network issues gracefully (timeouts, retries where appropriate)
- [ ] No lost or double-counted purchases on partial failure

### Concurrency Control
- [ ] **Prevents overselling** under concurrent load
- [ ] Race conditions handled (atomic decrement / locking / single-writer / transaction)
- [ ] "One item per user" enforced atomically alongside stock decrement

## 3. Testing Requirements

- [ ] **Unit tests** for core business logic (period, stock, per-user rule)
- [ ] **Integration tests** for API endpoints
- [ ] **Stress test** simulating high concurrent purchase volume
- [ ] Stress test **proves no overselling** (sold count ≤ stock)
- [ ] Stress test **proves one-per-user** holds under load
- [ ] Results are captured and explainable

## 4. Deliverables

- [ ] Source code in a Git repository
- [ ] `README.md` explaining design choices and trade-offs
- [ ] System diagram included in README
- [ ] Instructions to build/run **server**, **frontend**, and **tests**
- [ ] Instructions to run **stress tests** + summary of expected outcome

## 5. Code Quality (evaluation criteria)

- [ ] Clean, well-structured, maintainable code
- [ ] Sensible engineering trade-offs, explained
- [ ] Correctness of "one item per user" and "limited stock" under heavy load
