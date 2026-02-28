---
# SKOS
skos:prefLabel: Centroid
skos:definition: The center point of a cluster computed as the mean of all points assigned to that cluster, serving as the cluster representative.
skos:broader: ["[[K-Means Clustering]]"]
skos:narrower: []
skos:related: ["[[Distance Metrics]]"]

# SCHEMA.ORG
"@type": DefinedTerm
identifier: concept-centroid
dateCreated: "2026-02-10"

# METADATA
aliases: ["Cluster Center", "Mean Vector", "Cluster Prototype"]
tags: ["#concept", "#clustering", "#algorithm"]
---

# Centroid

## Definition

A **centroid** is the geometric center of a cluster, computed as the arithmetic mean of all observations assigned to that cluster. In K-Means clustering, centroids serve as cluster prototypes. ^definition

## Mathematical Formulation

For cluster C_k with n_k observations:

$$
\boldsymbol{\mu}_k = \frac{1}{n_k} \sum_{\mathbf{x}_i \in C_k} \mathbf{x}_i
$$

## Role in K-Means

1. **Assignment step**: Assign each point to nearest centroid
2. **Update step**: Recompute centroids as cluster means
3. **Convergence**: Repeat until centroids stabilize

## Properties

- **Minimizes WCSS**: Centroid is optimal for minimizing within-cluster variance
- **Sensitive to outliers**: Mean-based, affected by extreme values
- **Efficient computation**: O(np) time for n points, p features

## Python Implementation

```python
import numpy as np

def compute_centroid(X, labels, k):
    """Compute centroid for cluster k."""
    cluster_points = X[labels == k]
    return np.mean(cluster_points, axis=0)
```

## References

[1] James, G., Witten, D., Hastie, T., & Tibshirani, R. (2023). *An Introduction to Statistical Learning with Applications in Python* (2nd ed., Chapter 12). Springer.
