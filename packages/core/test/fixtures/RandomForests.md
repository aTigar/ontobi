---
skos:prefLabel: Random Forests
skos:definition: Ensemble method building collection of decorrelated decision trees via bootstrap sampling and random feature selection at splits, then averaging predictions to reduce variance while maintaining low bias.
skos:broader:
  - "[[Ensemble Methods]]"
skos:related:
  - "[[Decision Trees]]"
"@type": DefinedTerm
identifier: concept-random-forests
dateCreated: "[[17.01.2026]]"
aliases: []
tags:
  - "#concept"
---
---
skos:prefLabel: "Random Forests"
skos:definition: "Ensemble method building collection of decorrelated decision trees via bootstrap sampling and random feature selection at splits, then averaging predictions to reduce variance while maintaining low bias."
skos:broader: 
  - "[[Ensemble Methods]]"
skos:related: 
  - "[[Bootstrap Aggregation (Bagging)]]"
  - "[[Decision Trees]]"
  - "[[Out-of-Bag Error]]"
  - "[[Variable Importance]]"
  - "[[Variance Reduction]]"
"@type": "DefinedTerm"
identifier: "concept-random-forests"
dateCreated: "[[03.02.2026]]"
aliases: []
tags: ["#concept"]
---

# Random Forests

## Definition

Random Forests is an ensemble learning method that constructs multiple decision trees during training and outputs the class mode (classification) or mean prediction (regression) of individual trees. The key innovation over bagging is introducing randomness in feature selection at each split, decorrelating the trees to achieve superior variance reduction without increasing bias. ^definition

## Algorithm

The Random Forest algorithm consists of bootstrap sampling combined with random feature selection:

**For each tree $b = 1, 2, \ldots, B$:**
1. Draw a bootstrap sample $\mathcal{Z}^*$ of size $N$ from training data
2. Grow tree $T_b$ to bootstrapped data by recursively:
   - Select $m \leq p$ variables randomly from $p$ predictors
   - Choose best variable/split-point among the $m$
   - Split node into daughter nodes until minimum node size $n_{\min}$ reached

**Prediction:**
- **Regression:** $$f^B_{rf}(x) = \frac{1}{B}\sum_{b=1}^B T_b(x)$$
- **Classification:** Majority vote across $\{C_b(x)\}_{1}^B$

### Hyperparameters

- **Number of trees $B$:** Typically 500-1000; larger values do not cause overfitting
- **Features per split $m$:** 
  - Classification: $m = \sqrt{p}$ (default)
  - Regression: $m = p/3$ (default)
- **Minimum node size $n_{\min}$:**
  - Classification: 1 (grow deep trees)
  - Regression: 5

> [!tip]
> Using $B = 500$ is typically sufficient for error stabilization. Unlike boosting, random forests rarely overfit as $B$ increases.

## Decorrelation Mechanism

### Variance Decomposition

For identically distributed but correlated random variables with pairwise correlation $\rho$ and variance $\sigma^2$, the variance of the average is:

$$\text{Var}[\bar{X}] = \rho\sigma^2 + \frac{1-\rho}{B}\sigma^2$$

As $B \to \infty$, the second term vanishes but $\rho\sigma^2$ remains, limiting variance reduction. Random Forests addresses this by reducing $\rho$ through random feature selection.

### Correlation Between Trees

The sampling correlation between trees at point $x$ is:

$$\rho(x) = \text{corr}[T(x|\theta_1, \mathcal{Z}), T(x|\theta_2, \mathcal{Z})]$$

where $\theta$ represents random feature selection. Smaller $m$ reduces $\rho(x)$, enhancing decorrelation.

### Ensemble Variance

The variance of the random forest predictor is:

$$\text{Var}[f_{rf}(x)] = \rho(x)\sigma^2(x)$$

where $\sigma^2(x) = \text{Var}_{\theta,\mathcal{Z}}[T(x|\theta,\mathcal{Z})]$ is individual tree variance.

> [!warning]
> While increasing $B$ does not cause overfitting, growing excessively deep trees on small datasets can overfit. However, deep trees are generally preferred in random forests as averaging mitigates individual tree overfitting.

## Out-of-Bag (OOB) Error Estimation

Bootstrap sampling leaves approximately one-third observations unused per tree. OOB error is computed by:

1. For observation $i$, predict using only trees where $i$ was OOB
2. Aggregate $\approx B/3$ predictions (average for regression, majority vote for classification)
3. Compute OOB error across all $n$ observations

OOB error approximates leave-one-out cross-validation (LOOCV) error with sufficiently large $B$, providing free validation without separate test set.

## Variable Importance

### Gini Importance

For classification, compute total Gini index decrease from splits on variable $j$, averaged over all $B$ trees:

$$\text{Importance}_{\text{Gini}}(X_j) = \frac{1}{B}\sum_{b=1}^B \sum_{t \in T_b: v(t)=j} \Delta\text{Gini}(t)$$

where $v(t)$ denotes splitting variable at node $t$, and $\Delta\text{Gini}(t)$ is the improvement in Gini impurity from that split.

For regression, use RSS (residual sum of squares) decrease instead of Gini index.

### Permutation Importance

Alternative measure assessing prediction strength by randomly permuting variable values:

1. Compute OOB accuracy for tree $b$
2. Randomly permute values of variable $X_j$ in OOB samples
3. Re-compute OOB accuracy with permuted $X_j$
4. Record decrease in accuracy
5. Average decrease across all trees

$$\text{Importance}_{\text{perm}}(X_j) = \frac{1}{B}\sum_{b=1}^B \left[\text{Acc}_b^{\text{OOB}} - \text{Acc}_b^{\text{OOB},j\text{-perm}}\right]$$

Larger decreases indicate more important variables. This method avoids bias toward high-cardinality variables that affects Gini importance.

> [!example]
> In spam classification, if permuting "free" decreases accuracy by 8% but permuting "the" decreases it by 0.5%, "free" is more important for prediction.

## Bias-Variance Trade-off

### Variance and Decorrelation

The variance can be decomposed into within-$\mathcal{Z}$ and between-$\mathcal{Z}$ components:

$$\begin{align}
\text{Var}_{\theta,\mathcal{Z}}[T(x|\theta,\mathcal{Z})] &= \text{Var}_{\mathcal{Z}}[\mathbb{E}_{\theta|Z}[T(x|\theta,\mathcal{Z})]] \\
&\quad + \mathbb{E}_{\mathcal{Z}}[\text{Var}_{\theta|\mathcal{Z}}[T(x|\theta,\mathcal{Z})]]
\end{align}$$

- **Second term:** Within-$\mathcal{Z}$ variance from randomization (increases as $m$ decreases)
- **First term:** Sampling variance of ensemble (decreases as $m$ decreases due to decorrelation)

### Bias Characteristics

The bias of random forests equals the bias of individual sampled trees:

$$\text{Bias}(x) = \mu(x) - \mathbb{E}_{\mathcal{Z}}[f_{rf}(x)] = \mu(x) - \mathbb{E}_{\mathcal{Z},\theta}[T(x|\theta,\mathcal{Z})]$$

As $m$ decreases:
- **Bias increases:** Fewer features available means less flexibility to fit true function
- **Variance decreases:** Decorrelation effect dominates

Optimal $m$ balances this trade-off; typically found via cross-validation.

## Comparison with Other Methods

| Method | Trees Independent | Feature Sampling | Sequential | Overfitting Risk | Interpretability |
|--------|-------------------|------------------|------------|------------------|------------------|
| **Single Tree** | N/A | No | No | High | Excellent |
| **Bagging** | Yes | No | No | Low | Poor |
| **Random Forest** | Yes | Yes | No | Very Low | Poor |
| **Boosting** | No | No | Yes | Moderate | Poor |

### Key Differences

**Random Forests vs. Bagging:**
- Random Forests adds feature randomness at each split
- When $m = p$, Random Forests reduces to bagging
- Random Forests typically outperforms bagging when strong correlated predictors exist

**Random Forests vs. Boosting:**
- Random Forests builds trees independently; boosting builds sequentially
- Random Forests more robust to overfitting with large $B$
- Boosting often achieves slightly better performance but requires careful tuning

**Random Forests vs. Single Trees:**
- Random Forests dramatically reduces variance through averaging
- Single trees more interpretable but less accurate
- Random Forests maintains low bias of deep trees while reducing variance

> [!info]
> Random forests perform particularly well when there is one very strong predictor that would dominate all bagged trees, causing high correlation between trees.

## Computational Considerations

- **Training complexity:** $O(B \cdot n \cdot m \cdot \log n)$ for $n$ samples, $m$ features per split
- **Prediction complexity:** $O(B \cdot \text{depth})$
- **Parallelization:** Trees can be grown independently, enabling efficient parallel computation
- **Memory:** Requires storing $B$ trees, which can be substantial for large $B$ or deep trees

## Advantages and Limitations

### Advantages

1. Minimal tuning required; robust default hyperparameters
2. No overfitting with increasing $B$
3. Natural OOB error estimate without cross-validation
4. Handles mixed feature types and missing values well
5. Provides variable importance measures
6. Robust to outliers and non-linear relationships

### Limitations

1. Less interpretable than single decision trees
2. Can be slow for real-time prediction with large $B$
3. May not perform well with very high-dimensional sparse data (e.g., text)
4. Biased toward features with more categories (Gini importance)
5. Limited extrapolation capability beyond training data range

> [!warning]
> When the number of relevant variables is small relative to noise variables, random forests may struggle. In simulations with 2 relevant and 100+ noise variables, performance can degrade significantly unless $m$ is tuned carefully.

## References

Breiman, L. (2001). Random Forests. Machine Learning, 45(1), 5-32.

Hastie, T., Tibshirani, R., & Friedman, J. (2009). The Elements of Statistical Learning: Data Mining, Inference, and Prediction (2nd ed.). Springer. Chapter 15: Random Forests.

James, G., Witten, D., Hastie, T., & Tibshirani, R. (2023). An Introduction to Statistical Learning with Applications in Python. Springer. Chapter 8: Tree-Based Methods.
